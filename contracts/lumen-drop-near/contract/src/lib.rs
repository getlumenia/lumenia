//! lumenia-drop: send USDC by link on NEAR.
//!
//! The funder escrows NEP-141 USDC in this contract with `ft_transfer_call` and
//! shares a link whose URL fragment holds a fresh ed25519 secret key. The
//! contract adds that key to ITSELF as a function-call access key restricted to
//! `claim` and `claim_to_new_account`, so the recipient can sign a claim
//! transaction with no wallet, no seed phrase and no NEAR of their own: the key
//! allowance (paid from the contract balance, the "sponsor pool") covers the
//! gas. The payout destination is chosen at claim time. After the link expires
//! the funder takes the USDC back with `reclaim`.
//!
//! Every drop is a separate record keyed by its public key; the owner can
//! pause NEW drops only. Claim and reclaim always work while paused.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, Vector};
use std::collections::BTreeSet;
use near_sdk::{
    AccountId, Allowance, BorshStorageKey, CurveType, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseOrValue, PublicKey, env, near, require,
};

/// NEP-297 event standard name and version.
pub const EVENT_STANDARD: &str = "lumenia_drop";
pub const EVENT_VERSION: &str = "1.0.0";

/// Shortest link life a funder may ask for.
pub const MIN_EXPIRY_S: u64 = 60;
/// Memo bytes stored per drop (the pool pays for this storage).
pub const MAX_MEMO_BYTES: usize = 256;
/// A claim that has been `Claiming` for longer than this is considered stuck
/// and may be reclaimed by the funder (see README "stuck claim").
pub const STUCK_CLAIM_NS: u64 = 10 * 60 * NS_PER_S;
/// Methods a link key may call on this contract.
pub const CLAIM_METHODS: &str = "claim,claim_to_new_account";
/// Drops one batch `ft_transfer_call` may create (gas measured, see README).
pub const MAX_BATCH_DROPS: usize = 30;
/// Longest page a ledger view returns.
pub const MAX_PAGE: u64 = 100;

const NS_PER_S: u64 = 1_000_000_000;
/// Longest promise result a callback reads (a bool or nothing is expected).
const MAX_RESULT_BYTES: usize = 64;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

// Gas budgets. Static amounts are floors; the unused prepaid gas of each
// step is handed down by weight, so attaching more gas never hurts.
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(8);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_CLAIM: Gas = Gas::from_tgas(8);
const GAS_ON_RECLAIM: Gas = Gas::from_tgas(8);
/// Floor for the callback that builds the payout chain. It must hold the
/// three static budgets above plus the cost of creating those receipts.
const GAS_ON_ACCOUNT_READY: Gas = Gas::from_tgas(45);
/// Floor for the root linkdrop `create_account` call (it has its own callback).
const GAS_CREATE_ACCOUNT: Gas = Gas::from_tgas(25);
/// What a claim transaction must attach (the web client attaches 100 Tgas).
pub const MIN_GAS_CLAIM: Gas = Gas::from_tgas(60);
pub const MIN_GAS_CLAIM_TO_NEW_ACCOUNT: Gas = Gas::from_tgas(90);
pub const MIN_GAS_RECLAIM: Gas = Gas::from_tgas(30);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DropStatus {
    Open,
    Claiming,
    Claimed,
    Reclaimed,
}

impl DropStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DropStatus::Open => "Open",
            DropStatus::Claiming => "Claiming",
            DropStatus::Claimed => "Claimed",
            DropStatus::Reclaimed => "Reclaimed",
        }
    }
}

/// One escrowed payment, keyed by its link public key.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Drop {
    pub funder: AccountId,
    pub amount: U128,
    pub created_at_ns: u64,
    pub expires_at_ns: u64,
    pub status: DropStatus,
    pub claimed_to: Option<AccountId>,
    pub memo: Option<String>,
    /// Block time of the last status change (drives the stuck-claim window).
    pub status_changed_at_ns: u64,
}

/// What `get_drop` returns. Timestamps are strings because nanosecond values
/// do not fit a JavaScript number.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DropView {
    pub public_key: PublicKey,
    pub status: String,
    pub funder: AccountId,
    pub amount: U128,
    pub created_at_ns: U64,
    pub expires_at_ns: U64,
    pub claimed_to: Option<AccountId>,
    pub memo: Option<String>,
    pub status_changed_at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub token_id: AccountId,
    pub root_account_id: AccountId,
    pub paused: bool,
    pub key_allowance: U128,
    pub registration_deposit: U128,
    pub max_expiry_s: u64,
    pub starter_yocto: U128,
    pub min_amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StatsView {
    pub drops_created: u64,
    pub drops_claimed: u64,
    pub drops_reclaimed: u64,
    pub open_drops: u64,
    pub pool_balance: U128,
    /// 6-decimal USDC units.
    pub total_amount_created: U128,
    pub total_amount_claimed: U128,
    pub total_amount_reclaimed: U128,
}

/// The `msg` of the funder's `ft_transfer_call`.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct CreateDropMsg {
    pub public_key: PublicKey,
    pub expires_in_s: u64,
    #[serde(default)]
    pub memo: Option<String>,
}

/// One entry of a batch `ft_transfer_call` msg.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct BatchDropItem {
    pub public_key: PublicKey,
    pub amount: U128,
    #[serde(default)]
    pub memo: Option<String>,
}

/// The batch shape of the `ft_transfer_call` msg:
/// `{"drops":[{"public_key","amount","memo?"},...],"expires_in_s":N}`.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct BatchDropMsg {
    pub drops: Vec<BatchDropItem>,
    pub expires_in_s: u64,
}

pub enum CreateMsg {
    Single(CreateDropMsg),
    Batch(BatchDropMsg),
    /// A msg that announced a batch (has a `drops` key) but did not parse.
    InvalidBatch(String),
}

/// A msg with a `drops` key is a batch; anything else is the single shape
/// (which panics on a malformed msg, see `parse_create_msg`).
pub fn parse_msg(msg: &str) -> CreateMsg {
    if msg.contains("\"drops\"") {
        return match serde_json::from_str::<BatchDropMsg>(msg) {
            Ok(batch) => CreateMsg::Batch(batch),
            Err(e) => CreateMsg::InvalidBatch(e.to_string()),
        };
    }
    CreateMsg::Single(parse_create_msg(msg))
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Drops,
    AllKeys,
    ByFunder,
    FunderKeys { funder: AccountId },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    token_id: AccountId,
    root_account_id: AccountId,
    paused: bool,
    key_allowance: NearToken,
    registration_deposit: NearToken,
    max_expiry_s: u64,
    drops: LookupMap<PublicKey, Drop>,
    drops_created: u64,
    drops_claimed: u64,
    drops_reclaimed: u64,
    /// NEAR handed to an account the claim creates (an implicit destination or
    /// a new named account) so the recipient's first transactions cost nothing.
    starter_yocto: NearToken,
    /// Smallest drop accepted (6-decimal USDC units); dust is returned.
    min_amount: u128,
    /// Insertion-ordered ledger of every drop key (newest last).
    all_keys: Vector<PublicKey>,
    /// Per-funder ledger of drop keys (newest last).
    by_funder: LookupMap<AccountId, Vector<PublicKey>>,
    total_amount_created: u128,
    total_amount_claimed: u128,
    total_amount_reclaimed: u128,
}

/// The state layout of the first testnet deploy (code hash
/// 5ZuSGGyLxPe8t1Ldrajd9GZ8VJC9zNidMK1KQQzjYFJr), read once by `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV0 {
    owner_id: AccountId,
    token_id: AccountId,
    root_account_id: AccountId,
    paused: bool,
    key_allowance: NearToken,
    registration_deposit: NearToken,
    max_expiry_s: u64,
    drops: LookupMap<PublicKey, Drop>,
    drops_created: u64,
    drops_claimed: u64,
    drops_reclaimed: u64,
}

/// Parse and validate the `ft_transfer_call` msg. Panics with a readable
/// reason; a panic here makes the token contract refund the funder.
pub fn parse_create_msg(msg: &str) -> CreateDropMsg {
    let parsed: CreateDropMsg = match serde_json::from_str(msg) {
        Ok(m) => m,
        Err(e) => env::panic_str(&format!(
            "invalid msg: expected {{\"public_key\":\"ed25519:...\",\"expires_in_s\":N,\"memo\":\"optional\"}} ({e})"
        )),
    };
    require!(
        parsed.public_key.curve_type() == CurveType::ED25519,
        "public_key must be an ed25519 key"
    );
    if let Some(memo) = &parsed.memo {
        require!(memo.len() <= MAX_MEMO_BYTES, "memo is longer than 256 bytes");
    }
    parsed
}

/// True for a NEAR implicit account id: 64 lowercase hex characters.
pub fn is_implicit_account(account_id: &AccountId) -> bool {
    let s = account_id.as_str();
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// True when `account_id` is exactly `<name>.<root>` (one level below root).
pub fn is_direct_subaccount(account_id: &AccountId, root: &AccountId) -> bool {
    let suffix = format!(".{}", root.as_str());
    match account_id.as_str().strip_suffix(suffix.as_str()) {
        Some(name) => !name.is_empty() && !name.contains('.'),
        None => false,
    }
}

fn emit_event(event: &str, data: serde_json::Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

fn to_view(public_key: &PublicKey, d: &Drop) -> DropView {
    DropView {
        public_key: public_key.clone(),
        status: d.status.as_str().to_string(),
        funder: d.funder.clone(),
        amount: d.amount,
        created_at_ns: U64(d.created_at_ns),
        expires_at_ns: U64(d.expires_at_ns),
        claimed_to: d.claimed_to.clone(),
        memo: d.memo.clone(),
        status_changed_at_ns: U64(d.status_changed_at_ns),
    }
}

#[near]
impl Contract {
    /// Initialise once after deploy. The `#[init]` attribute panics when the
    /// contract state already exists.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_id: AccountId,
        token_id: AccountId,
        root_account_id: AccountId,
        key_allowance: U128,
        registration_deposit: U128,
        max_expiry_s: u64,
        starter_yocto: U128,
        min_amount: U128,
    ) -> Self {
        require!(key_allowance.0 > 0, "key_allowance must be positive");
        require!(
            max_expiry_s >= MIN_EXPIRY_S,
            "max_expiry_s must be at least 60 seconds"
        );
        Self {
            owner_id,
            token_id,
            root_account_id,
            paused: false,
            key_allowance: NearToken::from_yoctonear(key_allowance.0),
            registration_deposit: NearToken::from_yoctonear(registration_deposit.0),
            max_expiry_s,
            drops: LookupMap::new(StorageKey::Drops),
            drops_created: 0,
            drops_claimed: 0,
            drops_reclaimed: 0,
            starter_yocto: NearToken::from_yoctonear(starter_yocto.0),
            min_amount: min_amount.0,
            all_keys: Vector::new(StorageKey::AllKeys),
            by_funder: LookupMap::new(StorageKey::ByFunder),
            total_amount_created: 0,
            total_amount_claimed: 0,
            total_amount_reclaimed: 0,
        }
    }

    /// One-time upgrade of the first testnet deploy's state: keeps every
    /// drop record and counter, adds the config fields, the ledger indexes
    /// (empty: records made before the upgrade are reachable by key only) and
    /// the amount totals (start at 0). Only the contract account's own keys
    /// can call it (`#[private]`); link keys cannot.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(starter_yocto: U128, min_amount: U128) -> Self {
        let old: ContractV0 = match env::state_read() {
            Some(v0) => v0,
            None => env::panic_str("no state to migrate"),
        };
        Self {
            owner_id: old.owner_id,
            token_id: old.token_id,
            root_account_id: old.root_account_id,
            paused: old.paused,
            key_allowance: old.key_allowance,
            registration_deposit: old.registration_deposit,
            max_expiry_s: old.max_expiry_s,
            drops: old.drops,
            drops_created: old.drops_created,
            drops_claimed: old.drops_claimed,
            drops_reclaimed: old.drops_reclaimed,
            starter_yocto: NearToken::from_yoctonear(starter_yocto.0),
            min_amount: min_amount.0,
            all_keys: Vector::new(StorageKey::AllKeys),
            by_funder: LookupMap::new(StorageKey::ByFunder),
            total_amount_created: 0,
            total_amount_claimed: 0,
            total_amount_reclaimed: 0,
        }
    }

    // ------------------------------------------------------------------
    // Claim
    // ------------------------------------------------------------------

    /// Pay the drop whose link key signed this transaction to `account_id`.
    /// An implicit (64-hex) account that does not exist yet is created on the
    /// way by the transfer of `starter_yocto`; a named account must already
    /// exist and receives no NEAR.
    pub fn claim(&mut self, account_id: AccountId) -> Promise {
        require!(
            env::prepaid_gas() >= MIN_GAS_CLAIM,
            "attach at least 60 Tgas to claim"
        );
        let public_key = self.start_claim();
        // A transfer to a missing implicit account creates it (NEP-448
        // zero-balance accounts, even with 0 NEAR). The contract cannot see
        // whether an implicit account already exists, so every implicit
        // destination receives the starter; a named destination gets 0, and
        // a named account that does not exist makes the transfer fail, which
        // reopens the drop in `on_account_ready` instead of paying into the
        // void.
        let starter = if is_implicit_account(&account_id) {
            self.starter_yocto
        } else {
            NO_DEPOSIT
        };
        Promise::new(account_id.clone()).transfer(starter).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_ACCOUNT_READY)
                .with_unused_gas_weight(1)
                .on_account_ready(public_key, account_id, U128(starter.as_yoctonear())),
        )
    }

    /// Create the NAMED account `<name>.<root>` for the recipient through the
    /// root linkdrop contract, then pay the drop. The starter is attached to
    /// `create_account`: the linkdrop forwards it into the new account and
    /// refunds it to this contract when the name is taken.
    pub fn claim_to_new_account(
        &mut self,
        new_account_id: AccountId,
        new_public_key: PublicKey,
    ) -> Promise {
        require!(
            env::prepaid_gas() >= MIN_GAS_CLAIM_TO_NEW_ACCOUNT,
            "attach at least 90 Tgas to claim_to_new_account"
        );
        require!(
            is_direct_subaccount(&new_account_id, &self.root_account_id),
            "new_account_id must be <name>.<root_account_id>"
        );
        let public_key = self.start_claim();
        let args = json!({
            "new_account_id": new_account_id,
            "new_public_key": new_public_key,
        })
        .to_string()
        .into_bytes();
        let starter = self.starter_yocto;
        Promise::new(self.root_account_id.clone())
            .function_call_weight(
                "create_account",
                args,
                starter,
                GAS_CREATE_ACCOUNT,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_ACCOUNT_READY)
                    .with_unused_gas_weight(1)
                    .on_account_ready(public_key, new_account_id, U128(starter.as_yoctonear())),
            )
    }

    /// Shared guards of both claim entry points. Moves the drop to Claiming.
    fn start_claim(&mut self) -> PublicKey {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "claim must be a transaction signed by a link key of this contract"
        );
        let public_key = env::signer_account_pk();
        let now = env::block_timestamp();
        let drop = match self.drops.get_mut(&public_key) {
            Some(d) => d,
            None => env::panic_str("the signing key is not a drop key"),
        };
        match drop.status {
            DropStatus::Open => {}
            DropStatus::Claiming => env::panic_str("drop is already being claimed"),
            DropStatus::Claimed => env::panic_str("drop already claimed"),
            DropStatus::Reclaimed => env::panic_str("drop was taken back by the sender"),
        }
        require!(now < drop.expires_at_ns, "drop expired");
        drop.status = DropStatus::Claiming;
        drop.status_changed_at_ns = now;
        public_key
    }

    /// Callback after the recipient account was created or touched. Builds
    /// the payout chain: storage_deposit -> ft_transfer -> on_claim.
    #[private]
    pub fn on_account_ready(
        &mut self,
        public_key: PublicKey,
        account_id: AccountId,
        starter_yocto: U128,
    ) -> PromiseOrValue<bool> {
        require!(env::promise_results_count() == 1, "expected one promise result");
        let ready = match env::promise_result_checked(0, MAX_RESULT_BYTES) {
            // The root linkdrop answers `false` (not a failure) when the name is taken.
            Ok(bytes) => !matches!(serde_json::from_slice::<bool>(&bytes), Ok(false)),
            Err(_) => false,
        };
        if !ready {
            self.reopen(&public_key, "recipient account could not be created or does not exist");
            return PromiseOrValue::Value(false);
        }
        let (amount, memo) = match self.drops.get(&public_key) {
            Some(d) => (d.amount, d.memo.clone()),
            None => env::panic_str("drop vanished"),
        };
        let storage_args = json!({
            "account_id": account_id,
            "registration_only": true,
        })
        .to_string()
        .into_bytes();
        let transfer_args = json!({
            "receiver_id": account_id,
            "amount": amount,
            "memo": memo,
        })
        .to_string()
        .into_bytes();
        let chain = Promise::new(self.token_id.clone())
            .function_call_weight(
                "storage_deposit",
                storage_args,
                self.registration_deposit,
                GAS_STORAGE_DEPOSIT,
                GasWeight(1),
            )
            .then(Promise::new(self.token_id.clone()).function_call_weight(
                "ft_transfer",
                transfer_args,
                ONE_YOCTO,
                GAS_FT_TRANSFER,
                GasWeight(2),
            ))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_CLAIM)
                    .with_unused_gas_weight(1)
                    .on_claim(public_key, account_id, starter_yocto),
            );
        PromiseOrValue::Promise(chain)
    }

    /// Callback on the `ft_transfer` of a claim.
    #[private]
    pub fn on_claim(
        &mut self,
        public_key: PublicKey,
        account_id: AccountId,
        starter_yocto: U128,
    ) -> bool {
        require!(env::promise_results_count() == 1, "expected one promise result");
        let success = env::promise_result_checked(0, MAX_RESULT_BYTES).is_ok();
        if !success {
            self.reopen(&public_key, "ft_transfer to the recipient failed");
            return false;
        }
        let now = env::block_timestamp();
        let drop = match self.drops.get_mut(&public_key) {
            Some(d) => d,
            None => env::panic_str("drop vanished"),
        };
        drop.status = DropStatus::Claimed;
        drop.claimed_to = Some(account_id.clone());
        drop.status_changed_at_ns = now;
        let (funder, amount) = (drop.funder.clone(), drop.amount);
        self.drops_claimed = self.drops_claimed.saturating_add(1);
        self.total_amount_claimed = self.total_amount_claimed.saturating_add(amount.0);
        Promise::new(env::current_account_id())
            .delete_key(public_key.clone())
            .detach();
        emit_event(
            "drop_claimed",
            json!({
                "public_key": public_key,
                "funder": funder,
                "amount": amount,
                "claimed_to": account_id,
                "starter_yocto": starter_yocto,
            }),
        );
        true
    }

    // ------------------------------------------------------------------
    // Reclaim
    // ------------------------------------------------------------------

    /// The funder takes an expired, unclaimed drop back.
    pub fn reclaim(&mut self, public_key: PublicKey) -> Promise {
        require!(
            env::prepaid_gas() >= MIN_GAS_RECLAIM,
            "attach at least 30 Tgas to reclaim"
        );
        let now = env::block_timestamp();
        let drop = match self.drops.get_mut(&public_key) {
            Some(d) => d,
            None => env::panic_str("no drop for this key"),
        };
        require!(
            env::predecessor_account_id() == drop.funder,
            "only the funder may reclaim"
        );
        match drop.status {
            DropStatus::Open => {}
            DropStatus::Claiming => require!(
                now >= drop.status_changed_at_ns.saturating_add(STUCK_CLAIM_NS),
                "a claim is in progress"
            ),
            DropStatus::Claimed => env::panic_str("drop already claimed"),
            DropStatus::Reclaimed => env::panic_str("drop already reclaimed"),
        }
        require!(now >= drop.expires_at_ns, "drop has not expired yet");
        drop.status = DropStatus::Reclaimed;
        drop.status_changed_at_ns = now;
        let (funder, amount, memo) = (drop.funder.clone(), drop.amount, drop.memo.clone());
        let transfer_args = json!({
            "receiver_id": funder,
            "amount": amount,
            "memo": memo,
        })
        .to_string()
        .into_bytes();
        Promise::new(self.token_id.clone())
            .function_call_weight(
                "ft_transfer",
                transfer_args,
                ONE_YOCTO,
                GAS_FT_TRANSFER,
                GasWeight(2),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_RECLAIM)
                    .with_unused_gas_weight(1)
                    .on_reclaim(public_key),
            )
    }

    /// Callback on the `ft_transfer` of a reclaim.
    #[private]
    pub fn on_reclaim(&mut self, public_key: PublicKey) -> bool {
        require!(env::promise_results_count() == 1, "expected one promise result");
        let success = env::promise_result_checked(0, MAX_RESULT_BYTES).is_ok();
        if !success {
            self.reopen(&public_key, "ft_transfer back to the funder failed");
            return false;
        }
        let (funder, amount) = match self.drops.get(&public_key) {
            Some(d) => (d.funder.clone(), d.amount),
            None => env::panic_str("drop vanished"),
        };
        self.drops_reclaimed = self.drops_reclaimed.saturating_add(1);
        self.total_amount_reclaimed = self.total_amount_reclaimed.saturating_add(amount.0);
        Promise::new(env::current_account_id())
            .delete_key(public_key.clone())
            .detach();
        emit_event(
            "drop_reclaimed",
            json!({
                "public_key": public_key,
                "funder": funder,
                "amount": amount,
            }),
        );
        true
    }

    fn reopen(&mut self, public_key: &PublicKey, reason: &str) {
        let now = env::block_timestamp();
        if let Some(drop) = self.drops.get_mut(public_key) {
            drop.status = DropStatus::Open;
            drop.status_changed_at_ns = now;
        }
        env::log_str(&format!("drop reopened: {reason}"));
    }

    // ------------------------------------------------------------------
    // Owner and pool
    // ------------------------------------------------------------------

    /// Stop accepting NEW drops. Claim and reclaim keep working.
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit_event("paused", json!({ "by": env::predecessor_account_id() }));
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit_event("unpaused", json!({ "by": env::predecessor_account_id() }));
    }

    /// Anyone may add NEAR to the sponsor pool.
    #[payable]
    pub fn top_up(&mut self) {
        let amount = env::attached_deposit();
        require!(amount > NO_DEPOSIT, "attach the NEAR to add");
        emit_event(
            "pool_topped_up",
            json!({
                "from": env::predecessor_account_id(),
                "amount": U128(amount.as_yoctonear()),
            }),
        );
    }

    pub fn set_config(
        &mut self,
        key_allowance: Option<U128>,
        registration_deposit: Option<U128>,
        max_expiry_s: Option<u64>,
        starter_yocto: Option<U128>,
        min_amount: Option<U128>,
    ) {
        self.assert_owner();
        if let Some(v) = key_allowance {
            require!(v.0 > 0, "key_allowance must be positive");
            self.key_allowance = NearToken::from_yoctonear(v.0);
        }
        if let Some(v) = registration_deposit {
            self.registration_deposit = NearToken::from_yoctonear(v.0);
        }
        if let Some(v) = max_expiry_s {
            require!(v >= MIN_EXPIRY_S, "max_expiry_s must be at least 60 seconds");
            self.max_expiry_s = v;
        }
        if let Some(v) = starter_yocto {
            self.starter_yocto = NearToken::from_yoctonear(v.0);
        }
        if let Some(v) = min_amount {
            self.min_amount = v.0;
        }
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "owner only"
        );
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn get_drop(&self, public_key: PublicKey) -> Option<DropView> {
        self.drops.get(&public_key).map(|d| to_view(&public_key, d))
    }

    /// Public ledger, newest first. `from_index` 0 is the newest drop;
    /// `limit` defaults to 50 and is capped at 100.
    pub fn get_drops(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<DropView> {
        self.page(&self.all_keys, from_index, limit)
    }

    /// One funder's drops, newest first, same paging as `get_drops`.
    pub fn get_drops_by_funder(
        &self,
        funder: AccountId,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<DropView> {
        match self.by_funder.get(&funder) {
            Some(keys) => self.page(keys, from_index, limit),
            None => Vec::new(),
        }
    }

    fn page(
        &self,
        keys: &Vector<PublicKey>,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<DropView> {
        let n = u64::from(keys.len());
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(MAX_PAGE);
        let end = n.saturating_sub(from);
        let start = end.saturating_sub(limit);
        (start..end)
            .rev()
            .filter_map(|i| {
                let key = keys.get(u32::try_from(i).ok()?)?;
                self.drops.get(key).map(|d| to_view(key, d))
            })
            .collect()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner_id: self.owner_id.clone(),
            token_id: self.token_id.clone(),
            root_account_id: self.root_account_id.clone(),
            paused: self.paused,
            key_allowance: U128(self.key_allowance.as_yoctonear()),
            registration_deposit: U128(self.registration_deposit.as_yoctonear()),
            max_expiry_s: self.max_expiry_s,
            starter_yocto: U128(self.starter_yocto.as_yoctonear()),
            min_amount: U128(self.min_amount),
        }
    }

    pub fn get_stats(&self) -> StatsView {
        StatsView {
            drops_created: self.drops_created,
            drops_claimed: self.drops_claimed,
            drops_reclaimed: self.drops_reclaimed,
            open_drops: self
                .drops_created
                .saturating_sub(self.drops_claimed)
                .saturating_sub(self.drops_reclaimed),
            pool_balance: U128(env::account_balance().as_yoctonear()),
            total_amount_created: U128(self.total_amount_created),
            total_amount_claimed: U128(self.total_amount_claimed),
            total_amount_reclaimed: U128(self.total_amount_reclaimed),
        }
    }

    // ------------------------------------------------------------------
    // Create (shared by the single and the batch msg shapes)
    // ------------------------------------------------------------------

    /// Every check of a batch, before anything is written. `Err` carries the
    /// reason that is logged when the tokens are returned.
    fn validate_batch(&self, batch: &BatchDropMsg, total: u128) -> Result<(), String> {
        if batch.drops.is_empty() {
            return Err("batch has no drops".to_string());
        }
        if batch.drops.len() > MAX_BATCH_DROPS {
            return Err(format!(
                "batch has {} drops, at most {} are allowed",
                batch.drops.len(),
                MAX_BATCH_DROPS
            ));
        }
        if batch.expires_in_s < MIN_EXPIRY_S || batch.expires_in_s > self.max_expiry_s {
            return Err("expires_in_s must be between 60 and max_expiry_s".to_string());
        }
        let mut seen: BTreeSet<&PublicKey> = BTreeSet::new();
        let mut sum: u128 = 0;
        for (i, item) in batch.drops.iter().enumerate() {
            if item.public_key.curve_type() != CurveType::ED25519 {
                return Err(format!("drop {i}: public_key must be an ed25519 key"));
            }
            if item.memo.as_ref().is_some_and(|m| m.len() > MAX_MEMO_BYTES) {
                return Err(format!("drop {i}: memo is longer than 256 bytes"));
            }
            if item.amount.0 == 0 || item.amount.0 < self.min_amount {
                return Err(format!(
                    "drop {i}: amount {} is below min_amount {}",
                    item.amount.0, self.min_amount
                ));
            }
            if self.drops.contains_key(&item.public_key) {
                return Err(format!("drop {i}: public key already used by a drop"));
            }
            if !seen.insert(&item.public_key) {
                return Err(format!("drop {i}: public key repeated in the batch"));
            }
            sum = match sum.checked_add(item.amount.0) {
                Some(v) => v,
                None => return Err("amounts overflow".to_string()),
            };
        }
        if sum != total {
            return Err(format!("amounts sum to {sum} but {total} was transferred"));
        }
        Ok(())
    }

    /// Write one drop: record, ledger indexes, counters, link key, event.
    fn store_drop(
        &mut self,
        funder: &AccountId,
        public_key: PublicKey,
        amount: U128,
        expires_in_s: u64,
        memo: Option<String>,
    ) {
        let allowance = match Allowance::limited(self.key_allowance) {
            Some(a) => a,
            None => env::panic_str("key_allowance must be positive"),
        };
        let now = env::block_timestamp();
        let expires_at_ns = now.saturating_add(expires_in_s.saturating_mul(NS_PER_S));
        let drop = Drop {
            funder: funder.clone(),
            amount,
            created_at_ns: now,
            expires_at_ns,
            status: DropStatus::Open,
            claimed_to: None,
            memo,
            status_changed_at_ns: now,
        };
        self.drops.insert(public_key.clone(), drop);
        self.all_keys.push(public_key.clone());
        if !self.by_funder.contains_key(funder) {
            self.by_funder.insert(
                funder.clone(),
                Vector::new(StorageKey::FunderKeys {
                    funder: funder.clone(),
                }),
            );
        }
        if let Some(keys) = self.by_funder.get_mut(funder) {
            keys.push(public_key.clone());
        }
        self.drops_created = self.drops_created.saturating_add(1);
        self.total_amount_created = self.total_amount_created.saturating_add(amount.0);
        // The link key: a function-call key on this contract, limited to the
        // two claim methods, with a gas allowance paid by the pool.
        Promise::new(env::current_account_id())
            .add_access_key_allowance(
                public_key.clone(),
                allowance,
                env::current_account_id(),
                CLAIM_METHODS,
            )
            .detach();
        emit_event(
            "drop_created",
            json!({
                "public_key": public_key,
                "funder": funder,
                "amount": amount,
                "expires_at_ns": U64(expires_at_ns),
            }),
        );
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// Create a drop. Called by the token contract on the funder's
    /// `ft_transfer_call(receiver_id = this contract, amount, msg)`.
    /// Returns 0: every token is kept. Any panic refunds the funder.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token_id,
            "only the configured token contract may create drops"
        );
        // Dust is handed back without a panic: returning the whole amount as
        // "unused" makes the token refund the funder. Nothing is stored, so a
        // dust drop cannot farm starter NEAR or storage from the pool.
        if amount.0 < self.min_amount {
            env::log_str(&format!(
                "drop refused: amount {} is below min_amount {}; tokens returned",
                amount.0, self.min_amount
            ));
            return PromiseOrValue::Value(amount);
        }
        require!(!self.paused, "new drops are paused");
        require!(amount.0 > 0, "amount must be positive");
        match parse_msg(&msg) {
            CreateMsg::Single(parsed) => {
                require!(
                    parsed.expires_in_s >= MIN_EXPIRY_S
                        && parsed.expires_in_s <= self.max_expiry_s,
                    "expires_in_s must be between 60 and max_expiry_s"
                );
                require!(
                    !self.drops.contains_key(&parsed.public_key),
                    "public key already used by a drop"
                );
                self.store_drop(
                    &sender_id,
                    parsed.public_key,
                    amount,
                    parsed.expires_in_s,
                    parsed.memo,
                );
                PromiseOrValue::Value(U128(0))
            }
            // A batch is all or nothing: any problem returns every token
            // without a panic and writes no record.
            CreateMsg::Batch(batch) => match self.validate_batch(&batch, amount.0) {
                Ok(()) => {
                    let expires_in_s = batch.expires_in_s;
                    for item in batch.drops {
                        self.store_drop(
                            &sender_id,
                            item.public_key,
                            item.amount,
                            expires_in_s,
                            item.memo,
                        );
                    }
                    PromiseOrValue::Value(U128(0))
                }
                Err(reason) => {
                    env::log_str(&format!("batch refused: {reason}; tokens returned"));
                    PromiseOrValue::Value(amount)
                }
            },
            CreateMsg::InvalidBatch(reason) => {
                env::log_str(&format!("batch refused: invalid msg ({reason}); tokens returned"));
                PromiseOrValue::Value(amount)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{PromiseResult, testing_env};

    /// Set up the mocked blockchain with one promise result for a callback.
    fn env_with_result(b: &VMContextBuilder, r: PromiseResult) {
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![r],
        );
    }

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn key(n: u8) -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, vec![n; 32]).unwrap()
    }

    fn ctx(predecessor: &str, now_ns: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("drop.testnet"))
            .signer_account_id(acc(predecessor))
            .predecessor_account_id(acc(predecessor))
            .block_timestamp(now_ns)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(5));
        b
    }

    fn new_contract() -> Contract {
        testing_env!(ctx("owner.testnet", 0).build());
        Contract::new(
            acc("owner.testnet"),
            acc("usdc.testnet"),
            acc("testnet"),
            U128(NearToken::from_near(1).as_yoctonear()),
            U128(1_250_000_000_000_000_000_000),
            604_800,
            U128(STARTER),
            U128(MIN_AMOUNT),
        )
    }

    const STARTER: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
    const MIN_AMOUNT: u128 = 100_000; // 0.10 USDC

    fn msg(n: u8, expires_in_s: u64) -> String {
        format!(
            "{{\"public_key\":\"{}\",\"expires_in_s\":{},\"memo\":\"coffee\"}}",
            key(n),
            expires_in_s
        )
    }

    fn create(c: &mut Contract, n: u8, now_ns: u64) {
        testing_env!(ctx("usdc.testnet", now_ns).build());
        let out = c.ft_on_transfer(acc("funder.testnet"), U128(5_000_000), msg(n, 3600));
        assert!(matches!(out, PromiseOrValue::Value(U128(0))));
    }

    fn claim_ctx(n: u8, now_ns: u64) -> VMContextBuilder {
        let mut b = ctx("drop.testnet", now_ns);
        b.signer_account_pk(key(n));
        b
    }

    #[test]
    fn parses_a_valid_msg_and_defaults_the_memo() {
        let m = parse_create_msg(&format!(
            "{{\"public_key\":\"{}\",\"expires_in_s\":600}}",
            key(1)
        ));
        assert_eq!(m.public_key, key(1));
        assert_eq!(m.expires_in_s, 600);
        assert_eq!(m.memo, None);
        let m = parse_create_msg(&msg(2, 60));
        assert_eq!(m.memo.as_deref(), Some("coffee"));
    }

    #[test]
    #[should_panic(expected = "invalid msg")]
    fn rejects_a_msg_without_public_key() {
        parse_create_msg("{\"expires_in_s\":600}");
    }

    #[test]
    #[should_panic(expected = "invalid msg")]
    fn rejects_a_msg_that_is_not_json() {
        parse_create_msg("hello");
    }

    #[test]
    #[should_panic(expected = "memo is longer than 256 bytes")]
    fn rejects_a_long_memo() {
        let long = "x".repeat(257);
        parse_create_msg(&format!(
            "{{\"public_key\":\"{}\",\"expires_in_s\":600,\"memo\":\"{long}\"}}",
            key(1)
        ));
    }

    #[test]
    #[should_panic(expected = "ed25519")]
    fn rejects_a_secp256k1_key() {
        let pk = PublicKey::from_parts(CurveType::SECP256K1, vec![7; 64]).unwrap();
        parse_create_msg(&format!("{{\"public_key\":\"{pk}\",\"expires_in_s\":600}}"));
    }

    #[test]
    fn implicit_account_check() {
        let hex64 = "a".repeat(64);
        assert!(is_implicit_account(&acc(&hex64)));
        assert!(is_implicit_account(&acc(
            "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de"
        )));
        assert!(!is_implicit_account(&acc("alice.testnet")));
        assert!(!is_implicit_account(&acc(&"a".repeat(63))));
        assert!(!is_implicit_account(&acc(&"g".repeat(64))));
        // 64 chars but with a dot: a named account, not implicit
        let dotted = format!("{}.{}", "a".repeat(31), "b".repeat(32));
        assert_eq!(dotted.len(), 64);
        assert!(!is_implicit_account(&acc(&dotted)));
    }

    #[test]
    fn direct_subaccount_check() {
        let root = acc("testnet");
        assert!(is_direct_subaccount(&acc("alice.testnet"), &root));
        assert!(!is_direct_subaccount(&acc("a.alice.testnet"), &root));
        assert!(!is_direct_subaccount(&acc("testnet"), &root));
        assert!(!is_direct_subaccount(&acc("alice.near"), &root));
        assert!(!is_direct_subaccount(&acc("alicetestnet"), &root));
    }

    #[test]
    fn create_then_get_drop_is_open() {
        let mut c = new_contract();
        create(&mut c, 1, 1_000);
        let v = c.get_drop(key(1)).unwrap();
        assert_eq!(v.status, "Open");
        assert_eq!(v.amount, U128(5_000_000));
        assert_eq!(v.funder, acc("funder.testnet"));
        assert_eq!(v.created_at_ns, U64(1_000));
        assert_eq!(v.expires_at_ns, U64(1_000 + 3600 * NS_PER_S));
        assert_eq!(v.memo.as_deref(), Some("coffee"));
        assert_eq!(v.claimed_to, None);
        assert!(c.get_drop(key(2)).is_none());
        let s = c.get_stats();
        assert_eq!((s.drops_created, s.open_drops), (1, 1));
    }

    #[test]
    #[should_panic(expected = "public key already used")]
    fn reused_key_is_rejected() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        create(&mut c, 1, 0);
    }

    #[test]
    #[should_panic(expected = "only the configured token contract")]
    fn non_token_predecessor_cannot_create() {
        let mut c = new_contract();
        testing_env!(ctx("alice.testnet", 0).build());
        let _ = c.ft_on_transfer(acc("alice.testnet"), U128(1), msg(1, 3600));
    }

    #[test]
    #[should_panic(expected = "expires_in_s must be between")]
    fn expiry_above_max_is_rejected() {
        let mut c = new_contract();
        testing_env!(ctx("usdc.testnet", 0).build());
        let _ = c.ft_on_transfer(acc("f.testnet"), U128(MIN_AMOUNT), msg(1, 604_801));
    }

    #[test]
    #[should_panic(expected = "expires_in_s must be between")]
    fn expiry_below_min_is_rejected() {
        let mut c = new_contract();
        testing_env!(ctx("usdc.testnet", 0).build());
        let _ = c.ft_on_transfer(acc("f.testnet"), U128(MIN_AMOUNT), msg(1, 59));
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn zero_amount_is_rejected_when_there_is_no_minimum() {
        let mut c = new_contract();
        testing_env!(ctx("owner.testnet", 0).build());
        c.set_config(None, None, None, None, Some(U128(0)));
        testing_env!(ctx("usdc.testnet", 0).build());
        let _ = c.ft_on_transfer(acc("f.testnet"), U128(0), msg(1, 3600));
    }

    #[test]
    fn a_drop_below_min_amount_is_returned_without_a_record() {
        let mut c = new_contract();
        testing_env!(ctx("usdc.testnet", 0).build());
        let out = c.ft_on_transfer(acc("f.testnet"), U128(MIN_AMOUNT - 1), msg(1, 3600));
        assert!(matches!(out, PromiseOrValue::Value(U128(v)) if v == MIN_AMOUNT - 1));
        assert!(c.get_drop(key(1)).is_none());
        assert_eq!(c.get_stats().drops_created, 0);
        // exactly the minimum is accepted
        let out = c.ft_on_transfer(acc("f.testnet"), U128(MIN_AMOUNT), msg(1, 3600));
        assert!(matches!(out, PromiseOrValue::Value(U128(0))));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Open");
    }

    fn batch_msg(items: &[(u8, u128)], expires_in_s: u64) -> String {
        let drops: Vec<String> = items
            .iter()
            .map(|(k, a)| format!("{{\"public_key\":\"{}\",\"amount\":\"{a}\"}}", key(*k)))
            .collect();
        format!("{{\"drops\":[{}],\"expires_in_s\":{expires_in_s}}}", drops.join(","))
    }

    fn batch(c: &mut Contract, items: &[(u8, u128)], total: u128) -> PromiseOrValue<U128> {
        testing_env!(ctx("usdc.testnet", 0).build());
        c.ft_on_transfer(acc("funder.testnet"), U128(total), batch_msg(items, 3600))
    }

    fn returned(out: PromiseOrValue<U128>) -> u128 {
        match out {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => panic!("unexpected promise"),
        }
    }

    #[test]
    fn parse_msg_tells_the_shapes_apart() {
        assert!(matches!(parse_msg(&msg(1, 60)), CreateMsg::Single(_)));
        assert!(matches!(parse_msg(&batch_msg(&[(1, 5)], 60)), CreateMsg::Batch(b) if b.drops.len() == 1));
        assert!(matches!(
            parse_msg("{\"drops\":[{\"public_key\":\"nonsense\",\"amount\":\"1\"}],\"expires_in_s\":60}"),
            CreateMsg::InvalidBatch(_)
        ));
    }

    #[test]
    fn a_batch_creates_every_drop_and_the_ledger_pages_newest_first() {
        let mut c = new_contract();
        let items = [(1, MIN_AMOUNT), (2, 2 * MIN_AMOUNT), (3, 3 * MIN_AMOUNT)];
        assert_eq!(returned(batch(&mut c, &items, 6 * MIN_AMOUNT)), 0);
        for (k, a) in items {
            let d = c.get_drop(key(k)).expect("created");
            assert_eq!(d.status, "Open");
            assert_eq!(d.amount, U128(a));
            assert_eq!(d.funder, acc("funder.testnet"));
        }
        let s = c.get_stats();
        assert_eq!((s.drops_created, s.open_drops), (3, 3));
        assert_eq!(s.total_amount_created, U128(6 * MIN_AMOUNT));

        let order = |v: Vec<DropView>| v.into_iter().map(|d| d.public_key).collect::<Vec<_>>();
        assert_eq!(order(c.get_drops(None, None)), vec![key(3), key(2), key(1)]);
        assert_eq!(order(c.get_drops(Some(1), Some(1))), vec![key(2)]);
        assert_eq!(order(c.get_drops(Some(1), None)), vec![key(2), key(1)]);
        assert_eq!(order(c.get_drops(Some(3), None)), Vec::<PublicKey>::new());
        assert_eq!(order(c.get_drops(None, Some(0))), Vec::<PublicKey>::new());
        assert_eq!(
            order(c.get_drops_by_funder(acc("funder.testnet"), None, None)),
            vec![key(3), key(2), key(1)]
        );
        assert!(c.get_drops_by_funder(acc("alice.testnet"), None, None).is_empty());

        // a later single drop lands on top of the ledger
        create(&mut c, 4, 50);
        assert_eq!(order(c.get_drops(None, Some(2))), vec![key(4), key(3)]);
        assert_eq!(c.get_stats().total_amount_created, U128(6 * MIN_AMOUNT + 5_000_000));
    }

    #[test]
    fn a_batch_whose_amounts_do_not_sum_to_the_transfer_is_returned() {
        let mut c = new_contract();
        let items = [(1, MIN_AMOUNT), (2, 2 * MIN_AMOUNT)];
        assert_eq!(returned(batch(&mut c, &items, 4 * MIN_AMOUNT)), 4 * MIN_AMOUNT);
        assert!(c.get_drop(key(1)).is_none() && c.get_drop(key(2)).is_none());
        assert_eq!(c.get_stats().drops_created, 0);
        assert!(c.get_drops(None, None).is_empty());
    }

    #[test]
    fn a_batch_with_a_reused_or_repeated_key_or_dust_is_returned_entirely() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        // reused key (drop 1 exists)
        let total = 3 * MIN_AMOUNT;
        assert_eq!(returned(batch(&mut c, &[(1, MIN_AMOUNT), (2, MIN_AMOUNT), (3, MIN_AMOUNT)], total)), total);
        assert!(c.get_drop(key(2)).is_none() && c.get_drop(key(3)).is_none());
        // repeated inside the batch
        assert_eq!(returned(batch(&mut c, &[(2, MIN_AMOUNT), (2, MIN_AMOUNT), (3, MIN_AMOUNT)], total)), total);
        assert!(c.get_drop(key(2)).is_none());
        // one dust item
        assert_eq!(returned(batch(&mut c, &[(2, MIN_AMOUNT - 1), (3, 2 * MIN_AMOUNT + 1)], total)), total);
        assert!(c.get_drop(key(3)).is_none());
        // too many
        let many: Vec<(u8, u128)> = (10..=40).map(|k| (k, MIN_AMOUNT)).collect();
        assert_eq!(many.len(), 31);
        assert_eq!(returned(batch(&mut c, &many, 31 * MIN_AMOUNT)), 31 * MIN_AMOUNT);
        assert!(c.get_drop(key(10)).is_none());
        // exactly the cap is fine
        let cap: Vec<(u8, u128)> = (10..40).map(|k| (k, MIN_AMOUNT)).collect();
        assert_eq!(returned(batch(&mut c, &cap, 30 * MIN_AMOUNT)), 0);
        assert_eq!(c.get_stats().drops_created, 31);
        assert_eq!(c.get_drops(None, Some(100)).len(), 31);
        assert_eq!(c.get_drops_by_funder(acc("funder.testnet"), Some(30), Some(5)).len(), 1);
    }

    #[test]
    fn migrate_keeps_the_drops_and_adds_the_new_config() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut v0 = ContractV0 {
            owner_id: acc("owner.testnet"),
            token_id: acc("usdc.testnet"),
            root_account_id: acc("testnet"),
            paused: true,
            key_allowance: NearToken::from_near(1),
            registration_deposit: NearToken::from_yoctonear(1_250_000_000_000_000_000_000),
            max_expiry_s: 604_800,
            drops: LookupMap::new(StorageKey::Drops),
            drops_created: 3,
            drops_claimed: 1,
            drops_reclaimed: 1,
        };
        v0.drops.insert(
            key(4),
            Drop {
                funder: acc("funder.testnet"),
                amount: U128(777),
                created_at_ns: 5,
                expires_at_ns: 6,
                status: DropStatus::Open,
                claimed_to: None,
                memo: Some("old".into()),
                status_changed_at_ns: 5,
            },
        );
        v0.drops.flush();
        env::state_write(&v0);
        drop(v0);

        let c = Contract::migrate(U128(STARTER), U128(MIN_AMOUNT));
        let cfg = c.get_config();
        assert_eq!(cfg.owner_id, acc("owner.testnet"));
        assert!(cfg.paused);
        assert_eq!(cfg.starter_yocto, U128(STARTER));
        assert_eq!(cfg.min_amount, U128(MIN_AMOUNT));
        assert_eq!(cfg.max_expiry_s, 604_800);
        let s = c.get_stats();
        assert_eq!((s.drops_created, s.drops_claimed, s.drops_reclaimed, s.open_drops), (3, 1, 1, 1));
        let d = c.get_drop(key(4)).expect("drop survives the migration");
        assert_eq!(d.amount, U128(777));
        assert_eq!(d.memo.as_deref(), Some("old"));
        // the ledger starts empty for pre-upgrade records; totals start at 0
        assert!(c.get_drops(None, None).is_empty());
        assert_eq!(s.total_amount_created, U128(0));
    }

    #[test]
    fn claim_moves_the_drop_to_claiming() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(1, 10).build());
        let _ = c.claim(acc("alice.testnet"));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Claiming");
    }

    #[test]
    #[should_panic(expected = "drop is already being claimed")]
    fn double_claim_panics() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(1, 10).build());
        let _ = c.claim(acc("alice.testnet"));
        let _ = c.claim(acc("bob.testnet"));
    }

    #[test]
    #[should_panic(expected = "not a drop key")]
    fn claim_with_a_foreign_key_panics() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(9, 10).build());
        let _ = c.claim(acc("alice.testnet"));
    }

    #[test]
    #[should_panic(expected = "signed by a link key of this contract")]
    fn claim_from_another_account_panics() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        let mut b = ctx("alice.testnet", 10);
        b.signer_account_pk(key(1));
        testing_env!(b.build());
        let _ = c.claim(acc("alice.testnet"));
    }

    #[test]
    #[should_panic(expected = "drop expired")]
    fn claim_after_expiry_panics() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(1, 3600 * NS_PER_S).build());
        let _ = c.claim(acc("alice.testnet"));
    }

    #[test]
    #[should_panic(expected = "attach at least 60 Tgas")]
    fn claim_with_too_little_gas_panics() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        let mut b = claim_ctx(1, 10);
        b.prepaid_gas(Gas::from_tgas(50));
        testing_env!(b.build());
        let _ = c.claim(acc("alice.testnet"));
    }

    #[test]
    #[should_panic(expected = "must be <name>.<root_account_id>")]
    fn claim_to_new_account_rejects_a_deep_name() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(1, 10).build());
        let _ = c.claim_to_new_account(acc("a.b.testnet"), key(5));
    }

    #[test]
    fn claim_to_new_account_moves_the_drop_to_claiming() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(1, 10).build());
        let _ = c.claim_to_new_account(acc("fresh.testnet"), key(5));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Claiming");
    }

    #[test]
    fn on_claim_success_marks_claimed_and_counts() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(1, 10).build());
        let _ = c.claim(acc("alice.testnet"));
        env_with_result(&ctx("drop.testnet", 20), PromiseResult::Successful(vec![]));
        assert!(c.on_claim(key(1), acc("alice.testnet"), U128(0)));
        let v = c.get_drop(key(1)).unwrap();
        assert_eq!(v.status, "Claimed");
        assert_eq!(v.claimed_to, Some(acc("alice.testnet")));
        let s = c.get_stats();
        assert_eq!((s.drops_claimed, s.open_drops), (1, 0));
        assert_eq!(s.total_amount_claimed, U128(5_000_000));
    }

    #[test]
    fn on_claim_failure_reopens() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(1, 10).build());
        let _ = c.claim(acc("alice.testnet"));
        env_with_result(&ctx("drop.testnet", 20), PromiseResult::Failed);
        assert!(!c.on_claim(key(1), acc("alice.testnet"), U128(0)));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Open");
        assert_eq!(c.get_stats().drops_claimed, 0);
    }

    #[test]
    fn on_account_ready_reopens_when_the_root_says_false_or_fails() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(1, 10).build());
        let _ = c.claim_to_new_account(acc("taken.testnet"), key(5));
        env_with_result(&ctx("drop.testnet", 20), PromiseResult::Successful(b"false".to_vec()));
        assert!(matches!(
            c.on_account_ready(key(1), acc("taken.testnet"), U128(STARTER)),
            PromiseOrValue::Value(false)
        ));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Open");

        testing_env!(claim_ctx(1, 30).build());
        let _ = c.claim(acc("missing.testnet"));
        env_with_result(&ctx("drop.testnet", 40), PromiseResult::Failed);
        assert!(matches!(
            c.on_account_ready(key(1), acc("missing.testnet"), U128(0)),
            PromiseOrValue::Value(false)
        ));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Open");
    }

    #[test]
    fn on_account_ready_continues_on_success() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(claim_ctx(1, 10).build());
        let _ = c.claim(acc("alice.testnet"));
        env_with_result(&ctx("drop.testnet", 20), PromiseResult::Successful(vec![]));
        assert!(matches!(
            c.on_account_ready(key(1), acc("alice.testnet"), U128(0)),
            PromiseOrValue::Promise(_)
        ));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Claiming");
    }

    #[test]
    #[should_panic(expected = "has not expired yet")]
    fn reclaim_before_expiry_panics() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(ctx("funder.testnet", 10).build());
        let _ = c.reclaim(key(1));
    }

    #[test]
    #[should_panic(expected = "only the funder may reclaim")]
    fn reclaim_by_a_stranger_panics() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(ctx("alice.testnet", 3600 * NS_PER_S).build());
        let _ = c.reclaim(key(1));
    }

    #[test]
    fn reclaim_after_expiry_then_callback() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(ctx("funder.testnet", 3600 * NS_PER_S).build());
        let _ = c.reclaim(key(1));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Reclaimed");
        env_with_result(&ctx("drop.testnet", 3600 * NS_PER_S + 1), PromiseResult::Successful(vec![]));
        assert!(c.on_reclaim(key(1)));
        let s = c.get_stats();
        assert_eq!((s.drops_reclaimed, s.open_drops), (1, 0));
        assert_eq!(s.total_amount_reclaimed, U128(5_000_000));
    }

    #[test]
    fn reclaim_transfer_failure_reopens() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        testing_env!(ctx("funder.testnet", 3600 * NS_PER_S).build());
        let _ = c.reclaim(key(1));
        env_with_result(&ctx("drop.testnet", 3600 * NS_PER_S + 1), PromiseResult::Failed);
        assert!(!c.on_reclaim(key(1)));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Open");
    }

    #[test]
    #[should_panic(expected = "a claim is in progress")]
    fn reclaim_during_a_fresh_claim_panics() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        // claim starts 1 s before expiry; reclaim 1 s after expiry is inside the 10 min window
        testing_env!(claim_ctx(1, 3599 * NS_PER_S).build());
        let _ = c.claim(acc("alice.testnet"));
        testing_env!(ctx("funder.testnet", 3601 * NS_PER_S).build());
        let _ = c.reclaim(key(1));
    }

    #[test]
    fn reclaim_recovers_a_stuck_claim_after_ten_minutes() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        let t_claim = 3000 * NS_PER_S;
        testing_env!(claim_ctx(1, t_claim).build());
        let _ = c.claim(acc("alice.testnet"));
        testing_env!(ctx("funder.testnet", t_claim + STUCK_CLAIM_NS + 3600 * NS_PER_S).build());
        let _ = c.reclaim(key(1));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Reclaimed");
    }

    #[test]
    #[should_panic(expected = "new drops are paused")]
    fn pause_blocks_new_drops() {
        let mut c = new_contract();
        testing_env!(ctx("owner.testnet", 0).build());
        c.pause();
        assert!(c.get_config().paused);
        create(&mut c, 1, 0);
    }

    #[test]
    fn pause_never_blocks_claim_or_reclaim() {
        let mut c = new_contract();
        create(&mut c, 1, 0);
        create(&mut c, 2, 0);
        testing_env!(ctx("owner.testnet", 0).build());
        c.pause();
        testing_env!(claim_ctx(1, 10).build());
        let _ = c.claim(acc("alice.testnet"));
        assert_eq!(c.get_drop(key(1)).unwrap().status, "Claiming");
        testing_env!(ctx("funder.testnet", 3600 * NS_PER_S).build());
        let _ = c.reclaim(key(2));
        assert_eq!(c.get_drop(key(2)).unwrap().status, "Reclaimed");
        testing_env!(ctx("owner.testnet", 0).build());
        c.unpause();
        assert!(!c.get_config().paused);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn non_owner_cannot_pause() {
        let mut c = new_contract();
        testing_env!(ctx("alice.testnet", 0).build());
        c.pause();
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn non_owner_cannot_set_config() {
        let mut c = new_contract();
        testing_env!(ctx("alice.testnet", 0).build());
        c.set_config(None, None, Some(120), None, None);
    }

    #[test]
    fn owner_sets_config() {
        let mut c = new_contract();
        testing_env!(ctx("owner.testnet", 0).build());
        c.set_config(Some(U128(7)), Some(U128(8)), Some(120), Some(U128(9)), Some(U128(10)));
        let cfg = c.get_config();
        assert_eq!(cfg.key_allowance, U128(7));
        assert_eq!(cfg.registration_deposit, U128(8));
        assert_eq!(cfg.max_expiry_s, 120);
        assert_eq!(cfg.starter_yocto, U128(9));
        assert_eq!(cfg.min_amount, U128(10));
        assert_eq!(cfg.root_account_id, acc("testnet"));
        // defaults before the change were the init values
        let fresh = new_contract();
        assert_eq!(fresh.get_config().starter_yocto, U128(STARTER));
        assert_eq!(fresh.get_config().min_amount, U128(MIN_AMOUNT));
    }

    #[test]
    #[should_panic(expected = "attach the NEAR to add")]
    fn top_up_without_deposit_panics() {
        let mut c = new_contract();
        testing_env!(ctx("alice.testnet", 0).build());
        c.top_up();
    }
}
