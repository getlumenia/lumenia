//! Sandbox tests for lumenia-drop: a real nearcore sandbox (near-sandbox),
//! the mock USDC (test-usdc) and the mock root linkdrop (test-root), all three
//! built with cargo-near inside the test.
//!
//! Every test starts its own sandbox. The three wasm files are built once per
//! test binary run.

use near_api::advanced::ExecuteSignedTransaction;
use near_api::errors::ExecuteTransactionError;
use near_api::types::transaction::result::{ExecutionFinalResult, ExecutionSuccess, TransactionResult};
use near_api::types::TxExecutionStatus;
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, PublicKey, Signer};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

type TestResult<T = ()> = testresult::TestResult<T>;

const DROP: &str = "drop.sandbox";
const USDC: &str = "usdc.sandbox";
const ROOT: &str = "testnet";
const OWNER: &str = "owner.sandbox";
const FUNDER: &str = "funder.sandbox";
const ALICE: &str = "alice.sandbox";
const BOB: &str = "bob.sandbox";

const ONE_USDC: u128 = 1_000_000;
const FUNDER_SUPPLY: u128 = 1_000 * ONE_USDC;
const REG_DEPOSIT: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR
const KEY_ALLOWANCE: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR
const MAX_EXPIRY_S: u64 = 604_800;
const STARTER: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
const MIN_AMOUNT: u128 = 100_000; // 0.10 USDC
const NS_PER_S: u64 = 1_000_000_000;

struct Wasms {
    drop: Vec<u8>,
    usdc: Vec<u8>,
    root: Vec<u8>,
}

static WASMS: OnceLock<Wasms> = OnceLock::new();

fn build(manifest: Option<&str>) -> Vec<u8> {
    let mut opts = cargo_near_build::BuildOpts::default();
    if let Some(m) = manifest {
        opts.manifest_path = Some(cargo_near_build::camino::Utf8PathBuf::from(m));
    }
    let path = cargo_near_build::build_with_cli(opts).expect("cargo near build failed");
    std::fs::read(path).expect("read wasm")
}

fn wasms() -> &'static Wasms {
    WASMS.get_or_init(|| Wasms {
        drop: build(None),
        usdc: build(Some(concat!(env!("CARGO_MANIFEST_DIR"), "/../test-usdc/Cargo.toml"))),
        root: build(Some(concat!(env!("CARGO_MANIFEST_DIR"), "/../test-root/Cargo.toml"))),
    })
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct DropView {
    public_key: String,
    status: String,
    funder: AccountId,
    amount: String,
    created_at_ns: String,
    expires_at_ns: String,
    claimed_to: Option<AccountId>,
    memo: Option<String>,
    status_changed_at_ns: String,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct Stats {
    drops_created: u64,
    drops_claimed: u64,
    drops_reclaimed: u64,
    open_drops: u64,
    pool_balance: String,
    total_amount_created: String,
    total_amount_claimed: String,
    total_amount_reclaimed: String,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct Config {
    paused: bool,
    root_account_id: AccountId,
    starter_yocto: String,
    min_amount: String,
}

struct TestEnv {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    drop: Contract,
    usdc: Contract,
}

fn id(s: &str) -> AccountId {
    s.parse().expect("valid account id")
}

type SendResult = Result<TransactionResult, ExecuteTransactionError>;

impl TestEnv {
    async fn new() -> TestResult<Self> {
        let w = wasms();
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        for (name, near) in [
            (OWNER, 10),
            (FUNDER, 10),
            (ALICE, 10),
            (BOB, 10),
            (USDC, 10),
            (ROOT, 10),
            (DROP, 20),
        ] {
            sandbox
                .create_account(name.parse()?)
                .initial_balance(NearToken::from_near(near))
                .send()
                .await?;
        }
        let drop = Contract(id(DROP));
        let usdc = Contract(id(USDC));

        Contract::deploy(id(USDC))
            .use_code(w.usdc.clone())
            .with_init_call(
                "new",
                json!({ "owner_id": FUNDER, "total_supply": FUNDER_SUPPLY.to_string() }),
            )?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();

        Contract::deploy(id(ROOT))
            .use_code(w.root.clone())
            .without_init_call()
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();

        Contract::deploy(id(DROP))
            .use_code(w.drop.clone())
            .with_init_call(
                "new",
                json!({
                    "owner_id": OWNER,
                    "token_id": USDC,
                    "root_account_id": ROOT,
                    "key_allowance": KEY_ALLOWANCE.to_string(),
                    "registration_deposit": REG_DEPOSIT.to_string(),
                    "max_expiry_s": MAX_EXPIRY_S,
                    "starter_yocto": STARTER.to_string(),
                    "min_amount": MIN_AMOUNT.to_string(),
                }),
            )?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();

        let env = Self { sandbox, net, signer, drop, usdc };
        // The drop contract must be able to receive USDC; alice is a
        // registered recipient, bob deliberately is not.
        env.register_on_usdc(DROP).await?;
        env.register_on_usdc(ALICE).await?;
        Ok(env)
    }

    async fn register_on_usdc(&self, who: &str) -> TestResult {
        self.usdc
            .call_function(
                "storage_deposit",
                json!({ "account_id": who, "registration_only": true }),
            )
            .transaction()
            .deposit(NearToken::from_yoctonear(REG_DEPOSIT))
            .with_signer(id(who), self.signer.clone())
            .send_to(&self.net)
            .await?
            .assert_success();
        Ok(())
    }

    fn ft_transfer_call(&self, amount: u128, msg: &str) -> ExecuteSignedTransaction {
        self.ft_transfer_call_with_gas(amount, msg, 100)
    }

    fn ft_transfer_call_with_gas(&self, amount: u128, msg: &str, tgas: u64) -> ExecuteSignedTransaction {
        self.usdc
            .call_function(
                "ft_transfer_call",
                json!({ "receiver_id": DROP, "amount": amount.to_string(), "msg": msg }),
            )
            .transaction()
            .deposit(NearToken::from_yoctonear(1))
            .gas(NearGas::from_tgas(tgas))
            .with_signer(id(FUNDER), self.signer.clone())
    }

    /// A fresh link key pair for a batch entry.
    fn new_link() -> TestResult<(Arc<Signer>, PublicKey)> {
        let sk = near_api::signer::generate_secret_key()?;
        let pk = sk.public_key();
        Ok((Signer::from_secret_key(sk)?, pk))
    }

    async fn drops_page(&self, from_index: Option<u64>, limit: Option<u64>) -> TestResult<Vec<DropView>> {
        Ok(self
            .drop
            .call_function("get_drops", json!({ "from_index": from_index, "limit": limit }))
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn drops_by_funder(&self, funder: &str, from_index: Option<u64>, limit: Option<u64>) -> TestResult<Vec<DropView>> {
        Ok(self
            .drop
            .call_function(
                "get_drops_by_funder",
                json!({ "funder": funder, "from_index": from_index, "limit": limit }),
            )
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    /// Funder creates a drop; returns the link signer, its public key and the
    /// create transaction (for gas and logs).
    async fn create_drop(
        &self,
        amount: u128,
        expires_in_s: u64,
        memo: Option<&str>,
    ) -> TestResult<(Arc<Signer>, PublicKey, ExecutionSuccess)> {
        let sk = near_api::signer::generate_secret_key()?;
        let pk = sk.public_key();
        let msg = json!({ "public_key": pk.to_string(), "expires_in_s": expires_in_s, "memo": memo })
            .to_string();
        let ok = self.ft_transfer_call(amount, &msg).send_to(&self.net).await?.assert_success();
        self.wait_for_key(&pk).await?;
        Ok((Signer::from_secret_key(sk)?, pk, ok))
    }

    async fn wait_for_key(&self, pk: &PublicKey) -> TestResult {
        for _ in 0..50 {
            if self.key_exists(pk).await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Err("link key never appeared on the contract account".into())
    }

    async fn key_exists(&self, pk: &PublicKey) -> bool {
        Account(id(DROP))
            .access_key(*pk)
            .fetch_from(&self.net)
            .await
            .is_ok()
    }

    async fn claim(&self, link: &Arc<Signer>, target: &str) -> SendResult {
        self.drop
            .call_function("claim", json!({ "account_id": target }))
            .transaction()
            .gas(NearGas::from_tgas(100))
            .with_signer(id(DROP), link.clone())
            .send_to(&self.net)
            .await
    }

    async fn claim_to_new_account(
        &self,
        link: &Arc<Signer>,
        new_account_id: &str,
        new_public_key: &PublicKey,
    ) -> SendResult {
        self.drop
            .call_function(
                "claim_to_new_account",
                json!({ "new_account_id": new_account_id, "new_public_key": new_public_key.to_string() }),
            )
            .transaction()
            .gas(NearGas::from_tgas(100))
            .with_signer(id(DROP), link.clone())
            .send_to(&self.net)
            .await
    }

    async fn reclaim(&self, pk: &PublicKey, by: &str) -> SendResult {
        self.drop
            .call_function("reclaim", json!({ "public_key": pk.to_string() }))
            .transaction()
            .gas(NearGas::from_tgas(100))
            .with_signer(id(by), self.signer.clone())
            .send_to(&self.net)
            .await
    }

    async fn owner_call(&self, method: &str, by: &str) -> SendResult {
        self.drop
            .call_function(method, json!({}))
            .transaction()
            .with_signer(id(by), self.signer.clone())
            .send_to(&self.net)
            .await
    }

    async fn usdc_balance(&self, who: &str) -> TestResult<u128> {
        let s: String = self
            .usdc
            .call_function("ft_balance_of", json!({ "account_id": who }))
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data;
        Ok(s.parse()?)
    }

    async fn drop_view(&self, pk: &PublicKey) -> TestResult<Option<DropView>> {
        Ok(self
            .drop
            .call_function("get_drop", json!({ "public_key": pk.to_string() }))
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn status(&self, pk: &PublicKey) -> TestResult<String> {
        Ok(self.drop_view(pk).await?.map(|d| d.status).unwrap_or_else(|| "missing".into()))
    }

    async fn stats(&self) -> TestResult<Stats> {
        Ok(self
            .drop
            .call_function("get_stats", json!({}))
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn config(&self) -> TestResult<Config> {
        Ok(self
            .drop
            .call_function("get_config", json!({}))
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn account_exists(&self, who: &str) -> bool {
        Account(id(who)).view().fetch_from(&self.net).await.is_ok()
    }

    async fn near_balance(&self, who: &str) -> TestResult<NearToken> {
        Ok(Account(id(who)).view().fetch_from(&self.net).await?.data.amount)
    }

    async fn chain_time_ns(&self) -> TestResult<u64> {
        let block = near_api::Chain::block().fetch_from(&self.net).await?;
        let v: Value = near_sdk::serde_json::to_value(&block)?;
        let ts = &v["header"]["timestamp_nanosec"];
        let ns = match ts {
            Value::String(s) => s.parse::<u64>()?,
            Value::Number(n) => n.as_u64().ok_or("timestamp")?,
            _ => return Err("no timestamp_nanosec in block header".into()),
        };
        Ok(ns)
    }

    /// Fast-forward the sandbox until chain time is past `target_ns`.
    async fn fast_forward_past(&self, target_ns: u64) -> TestResult {
        for _ in 0..40 {
            if self.chain_time_ns().await? > target_ns + 2 * NS_PER_S {
                return Ok(());
            }
            self.sandbox.fast_forward(200).await?;
        }
        Err("fast_forward did not reach the target time".into())
    }

    async fn expires_at_ns(&self, pk: &PublicKey) -> TestResult<u64> {
        Ok(self.drop_view(pk).await?.ok_or("drop missing")?.expires_at_ns.parse()?)
    }

    fn key_list(keys: &[PublicKey]) -> Value {
        json!({ "public_keys": keys.iter().map(|k| k.to_string()).collect::<Vec<_>>() })
    }

    /// Arms a return timer. Sent with wait_until INCLUDED: a transaction whose timer is pending
    /// does not reach FINAL until the timer ends. (The sandbox cannot show that transaction's
    /// receipts afterwards: after a fast-forward it no longer finds it, so the tests read effects.)
    async fn arm(&self, keys: &[PublicKey], by: &str, tgas: u64) -> TestResult {
        let _pending = self
            .drop
            .call_function("arm_return", Self::key_list(keys))
            .transaction()
            .gas(NearGas::from_tgas(tgas))
            .with_signer(id(by), self.signer.clone())
            .wait_until(TxExecutionStatus::Included)
            .send_to(&self.net)
            .await?;
        // let the arm receipt run before anyone looks
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Ok(())
    }

    /// An arm that is expected to fail: it creates no timer, so it reaches FINAL.
    async fn arm_final(&self, keys: &[PublicKey], by: &str, tgas: u64) -> SendResult {
        self.drop
            .call_function("arm_return", Self::key_list(keys))
            .transaction()
            .gas(NearGas::from_tgas(tgas))
            .with_signer(id(by), self.signer.clone())
            .send_to(&self.net)
            .await
    }

    async fn return_expired(&self, keys: &[PublicKey], by: &str) -> SendResult {
        self.drop
            .call_function("return_expired", Self::key_list(keys))
            .transaction()
            .gas(NearGas::from_tgas(100))
            .with_signer(id(by), self.signer.clone())
            .send_to(&self.net)
            .await
    }

    /// Lets blocks pass, 100 at a time, until every key has `status` (at most `rounds` rounds).
    async fn wait_for_status(&self, keys: &[PublicKey], status: &str, rounds: usize) -> TestResult {
        for _ in 0..rounds {
            let mut all = true;
            for k in keys {
                if self.status(k).await? != status {
                    all = false;
                    break;
                }
            }
            if all {
                return Ok(());
            }
            self.sandbox.fast_forward(100).await?;
        }
        Err(format!("the links did not reach {status} in {rounds} rounds of 100 blocks").into())
    }

    async fn block_header(&self) -> TestResult<Value> {
        let block = near_api::Chain::block().fetch_from(&self.net).await?;
        Ok(near_sdk::serde_json::to_value(&block)?["header"].clone())
    }

    async fn height(&self) -> TestResult<u64> {
        self.block_header().await?["height"].as_u64().ok_or_else(|| "no height in block header".into())
    }

    async fn gas_price(&self) -> TestResult<u128> {
        let h = self.block_header().await?;
        let p = &h["gas_price"];
        Ok(match p {
            Value::String(s) => s.parse()?,
            Value::Number(n) => u128::from(n.as_u64().ok_or("gas_price")?),
            _ => return Err("no gas_price in block header".into()),
        })
    }

    /// The status turns Reclaimed when a return starts; the transfer, `on_return` and the key
    /// deletions run in the next blocks. Waits until `on_return` has counted `n` returns, then lets
    /// the key deletions land.
    async fn wait_for_returned(&self, n: u64) -> TestResult {
        for _ in 0..30 {
            if self.stats().await?.drops_reclaimed >= n {
                self.sandbox.fast_forward(5).await?;
                return Ok(());
            }
            self.sandbox.fast_forward(2).await?;
        }
        Err(format!("on_return did not count {n} returns").into())
    }

    async fn storage_usage(&self, who: &str) -> TestResult<u64> {
        Ok(Account(id(who)).view().fetch_from(&self.net).await?.data.storage_usage)
    }
}

/// A send that failed, either rejected before execution or with a failed
/// execution status. Returns the error text for `needle` checks.
fn failure_text(r: SendResult) -> String {
    match r {
        Ok(res) => {
            assert!(res.is_failure(), "expected the transaction to fail");
            format!("{:?}", res.assert_failure().failures())
        }
        Err(e) => format!("{e:?}"),
    }
}

fn assert_failed_with(r: SendResult, needle: &str) {
    let text = failure_text(r);
    assert!(text.contains(needle), "expected failure containing {needle:?}, got: {text}");
}

/// The complete outcome of a transaction that was executed (not pending).
fn full(r: TransactionResult) -> ExecutionFinalResult {
    r.into_full().expect("transaction result is pending")
}

fn implicit_account_for(pk: &PublicKey) -> String {
    hex::encode(pk.key_data())
}

fn has_event(ok: &ExecutionSuccess, event: &str) -> bool {
    ok.logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains(&format!("\"event\":\"{event}\"")))
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_then_get_drop_is_open_and_the_link_key_exists() -> TestResult {
    let env = TestEnv::new().await?;
    let (_link, pk, ok) = env.create_drop(5 * ONE_USDC, 3600, Some("coffee")).await?;
    println!("GAS create (ft_transfer_call -> ft_on_transfer): {}", ok.total_gas_burnt);
    assert!(has_event(&ok, "drop_created"));

    let d = env.drop_view(&pk).await?.expect("drop exists");
    assert_eq!(d.status, "Open");
    assert_eq!(d.public_key, pk.to_string());
    assert_eq!(d.funder, id(FUNDER));
    assert_eq!(d.amount, (5 * ONE_USDC).to_string());
    assert_eq!(d.memo.as_deref(), Some("coffee"));
    assert!(d.claimed_to.is_none());
    let created: u64 = d.created_at_ns.parse()?;
    let expires: u64 = d.expires_at_ns.parse()?;
    assert_eq!(expires - created, 3600 * NS_PER_S);

    // the USDC sits in the contract, the funder gave it up
    assert_eq!(env.usdc_balance(DROP).await?, 5 * ONE_USDC);
    assert_eq!(env.usdc_balance(FUNDER).await?, FUNDER_SUPPLY - 5 * ONE_USDC);

    // the link key is a function-call key limited to the two claim methods
    let key = Account(id(DROP)).access_key(pk).fetch_from(&env.net).await?.data;
    let perm = format!("{:?}", key.permission);
    assert!(perm.contains("FunctionCall"), "{perm}");
    assert!(perm.contains("\"claim\"") && perm.contains("\"claim_to_new_account\""), "{perm}");
    assert!(perm.contains(DROP), "{perm}");
    assert!(!perm.contains("FullAccess"));

    let s = env.stats().await?;
    assert_eq!((s.drops_created, s.drops_claimed, s.drops_reclaimed, s.open_drops), (1, 0, 0, 1));
    assert!(s.pool_balance.parse::<u128>()? > 0);
    Ok(())
}

#[tokio::test]
async fn claim_to_an_existing_registered_account() -> TestResult {
    let env = TestEnv::new().await?;
    let (link, pk, _) = env.create_drop(5 * ONE_USDC, 3600, None).await?;
    let pool_before = env.near_balance(DROP).await?;
    let alice_near_before = env.near_balance(ALICE).await?;

    let ok = env.claim(&link, ALICE).await?.assert_success();
    println!("GAS claim to registered account: {}", ok.total_gas_burnt);
    assert_eq!(env.near_balance(ALICE).await?, alice_near_before, "an existing account gets no starter NEAR");
    assert!(ok.logs().iter().any(|l| l.contains("\"starter_yocto\":\"0\"")), "{:?}", ok.logs());
    assert!(has_event(&ok, "drop_claimed"), "logs: {:?}", ok.logs());
    assert!(ok.receipt_failures().is_empty(), "{:?}", ok.receipt_failures());

    assert_eq!(env.usdc_balance(ALICE).await?, 5 * ONE_USDC);
    assert_eq!(env.usdc_balance(DROP).await?, 0);
    let d = env.drop_view(&pk).await?.expect("drop");
    assert_eq!(d.status, "Claimed");
    assert_eq!(d.claimed_to, Some(id(ALICE)));
    assert!(!env.key_exists(&pk).await, "link key must be deleted after the claim");
    let s = env.stats().await?;
    assert_eq!((s.drops_claimed, s.open_drops), (1, 0));
    // an already registered recipient costs the pool only gas: the token refunds the deposit
    let pool_after = env.near_balance(DROP).await?;
    let spent = pool_before.as_yoctonear().saturating_sub(pool_after.as_yoctonear());
    println!("pool NEAR spent on a registered-recipient claim: {spent} yocto");
    assert!(spent < REG_DEPOSIT, "the registration deposit must come back: spent {spent}");
    Ok(())
}

#[tokio::test]
async fn claim_to_an_unregistered_existing_account_pays_registration_from_the_pool() -> TestResult {
    let env = TestEnv::new().await?;
    let (link, pk, _) = env.create_drop(2 * ONE_USDC, 3600, None).await?;
    let pool_before = env.near_balance(DROP).await?;
    let bob_near_before = env.near_balance(BOB).await?;

    let ok = env.claim(&link, BOB).await?.assert_success();
    println!("GAS claim to unregistered account: {}", ok.total_gas_burnt);
    assert_eq!(env.near_balance(BOB).await?, bob_near_before, "an existing account gets no starter NEAR");
    assert!(ok.receipt_failures().is_empty(), "{:?}", ok.receipt_failures());
    assert_eq!(env.usdc_balance(BOB).await?, 2 * ONE_USDC);
    assert_eq!(env.status(&pk).await?, "Claimed");

    let pool_after = env.near_balance(DROP).await?;
    let spent = pool_before.as_yoctonear().saturating_sub(pool_after.as_yoctonear());
    println!("pool NEAR spent on an unregistered-recipient claim: {spent} yocto");
    assert!(spent >= REG_DEPOSIT, "the pool paid the registration: spent {spent}");
    Ok(())
}

#[tokio::test]
async fn hero_path_claim_to_a_fresh_implicit_account_that_does_not_exist_yet() -> TestResult {
    let env = TestEnv::new().await?;
    let (link, pk, _) = env.create_drop(10 * ONE_USDC, 3600, Some("welcome")).await?;

    let recipient_sk = near_api::signer::generate_secret_key()?;
    let implicit = implicit_account_for(&recipient_sk.public_key());
    assert_eq!(implicit.len(), 64);
    assert!(!env.account_exists(&implicit).await, "fresh implicit account must not exist yet");

    let ok = env.claim(&link, &implicit).await?.assert_success();
    println!("GAS claim to fresh implicit account: {}", ok.total_gas_burnt);
    assert!(ok.receipt_failures().is_empty(), "{:?}", ok.receipt_failures());
    assert!(has_event(&ok, "drop_claimed"), "logs: {:?}", ok.logs());

    assert!(env.account_exists(&implicit).await, "the starter transfer must create the implicit account");
    assert_eq!(env.near_balance(&implicit).await?, NearToken::from_yoctonear(STARTER), "exactly the starter");
    assert_eq!(env.usdc_balance(&implicit).await?, 10 * ONE_USDC);
    assert!(
        ok.logs().iter().any(|l| l.contains(&format!("\"starter_yocto\":\"{STARTER}\""))),
        "{:?}",
        ok.logs()
    );
    let d = env.drop_view(&pk).await?.expect("drop");
    assert_eq!(d.status, "Claimed");
    assert_eq!(d.claimed_to, Some(id(&implicit)));
    assert!(!env.key_exists(&pk).await);

    // the recipient now controls the account with the key the hex came from
    let recipient = Signer::from_secret_key(recipient_sk)?;
    let moved = env
        .usdc
        .call_function("ft_transfer", json!({ "receiver_id": ALICE, "amount": ONE_USDC.to_string() }))
        .transaction()
        // NEAR reserves the prepaid gas up front at a pessimistically inflated
        // price (1.03 per possible receipt hop): with a 0.01 NEAR balance a
        // 5 Tgas ft_transfer is accepted, 10 Tgas or more is refused as
        // NotEnoughBalance (measured in this sandbox). The actual burn is
        // about 0.0003 NEAR, so the starter pays for many such transfers.
        .gas(NearGas::from_tgas(5))
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(id(&implicit), recipient)
        .send_to(&env.net)
        .await;
    // the starter pays the gas of the recipient's first outgoing transaction
    let moved = moved?.assert_success();
    println!("GAS recipient's first outgoing ft_transfer: {}", moved.total_gas_burnt);
    assert_eq!(env.usdc_balance(ALICE).await?, ONE_USDC);
    assert_eq!(env.usdc_balance(&implicit).await?, 9 * ONE_USDC);
    let left = env.near_balance(&implicit).await?;
    println!("starter left after one outgoing transfer: {left}");
    assert!(left.as_yoctonear() > STARTER / 2, "one transfer must not eat more than half the starter");
    Ok(())
}

#[tokio::test]
async fn claim_with_a_key_that_is_not_a_drop_key_fails() -> TestResult {
    let env = TestEnv::new().await?;
    let (_link, pk, _) = env.create_drop(ONE_USDC, 3600, None).await?;

    // the contract's own full-access key is not a drop key: contract-level panic
    let r = env
        .drop
        .call_function("claim", json!({ "account_id": ALICE }))
        .transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(id(DROP), env.signer.clone())
        .send_to(&env.net)
        .await;
    assert_failed_with(r, "not a drop key");

    // a random key that was never added: rejected before execution
    let stranger = Signer::from_secret_key(near_api::signer::generate_secret_key()?)?;
    let r = env.claim(&stranger, ALICE).await;
    let text = failure_text(r);
    println!("stranger key rejection: {}", text.chars().take(160).collect::<String>());

    assert_eq!(env.status(&pk).await?, "Open");
    assert_eq!(env.usdc_balance(ALICE).await?, 0);
    Ok(())
}

#[tokio::test]
async fn claim_after_expiry_fails() -> TestResult {
    let env = TestEnv::new().await?;
    let (link, pk, _) = env.create_drop(ONE_USDC, 60, None).await?;
    let expires = env.expires_at_ns(&pk).await?;
    env.fast_forward_past(expires).await?;

    assert_failed_with(env.claim(&link, ALICE).await, "drop expired");
    assert_eq!(env.status(&pk).await?, "Open");
    assert_eq!(env.usdc_balance(DROP).await?, ONE_USDC);
    assert!(env.key_exists(&pk).await);
    Ok(())
}

#[tokio::test]
async fn double_claim_fails() -> TestResult {
    let env = TestEnv::new().await?;
    let (link, pk, _) = env.create_drop(3 * ONE_USDC, 3600, None).await?;
    env.claim(&link, ALICE).await?.assert_success();
    assert_eq!(env.status(&pk).await?, "Claimed");

    // the key is gone, so the second claim cannot even be signed in
    let text = failure_text(env.claim(&link, BOB).await);
    println!("second claim rejection: {}", text.chars().take(160).collect::<String>());
    assert_eq!(env.usdc_balance(ALICE).await?, 3 * ONE_USDC);
    assert_eq!(env.usdc_balance(BOB).await?, 0);
    assert_eq!(env.status(&pk).await?, "Claimed");
    assert_eq!(env.stats().await?.drops_claimed, 1);
    Ok(())
}

#[tokio::test]
async fn reclaim_before_expiry_fails() -> TestResult {
    let env = TestEnv::new().await?;
    let (_link, pk, _) = env.create_drop(ONE_USDC, 3600, None).await?;
    assert_failed_with(env.reclaim(&pk, FUNDER).await, "has not expired yet");
    assert_eq!(env.status(&pk).await?, "Open");
    assert_eq!(env.usdc_balance(FUNDER).await?, FUNDER_SUPPLY - ONE_USDC);
    Ok(())
}

#[tokio::test]
async fn reclaim_after_expiry_returns_the_usdc_to_the_funder() -> TestResult {
    let env = TestEnv::new().await?;
    let (link, pk, _) = env.create_drop(4 * ONE_USDC, 60, Some("late")).await?;
    let expires = env.expires_at_ns(&pk).await?;
    env.fast_forward_past(expires).await?;

    // a stranger cannot reclaim
    assert_failed_with(env.reclaim(&pk, ALICE).await, "only the funder may reclaim");

    let ok = env.reclaim(&pk, FUNDER).await?.assert_success();
    println!("GAS reclaim: {}", ok.total_gas_burnt);
    assert!(ok.receipt_failures().is_empty(), "{:?}", ok.receipt_failures());
    assert!(has_event(&ok, "drop_reclaimed"));
    assert_eq!(env.usdc_balance(FUNDER).await?, FUNDER_SUPPLY);
    assert_eq!(env.usdc_balance(DROP).await?, 0);
    assert_eq!(env.status(&pk).await?, "Reclaimed");
    assert!(!env.key_exists(&pk).await, "link key must be deleted after the reclaim");
    let s = env.stats().await?;
    assert_eq!((s.drops_reclaimed, s.open_drops), (1, 0));
    assert_eq!(s.total_amount_reclaimed, (4 * ONE_USDC).to_string());
    assert_eq!(s.total_amount_claimed, "0");

    // the old link is dead: claim after reclaim fails
    let text = failure_text(env.claim(&link, ALICE).await);
    assert!(!text.is_empty());
    Ok(())
}

#[tokio::test]
async fn pause_blocks_new_drops_but_a_pending_claim_and_a_reclaim_still_work() -> TestResult {
    let env = TestEnv::new().await?;
    let (link1, pk1, _) = env.create_drop(ONE_USDC, 3600, None).await?;
    let (_link2, pk2, _) = env.create_drop(2 * ONE_USDC, 60, None).await?;

    let ok = env.owner_call("pause", OWNER).await?.assert_success();
    assert!(has_event(&ok, "paused"));
    assert!(env.config().await?.paused);

    // a new drop is refused: ft_on_transfer panics and the token refunds the funder
    let funder_before = env.usdc_balance(FUNDER).await?;
    let sk = near_api::signer::generate_secret_key()?;
    let msg = json!({ "public_key": sk.public_key().to_string(), "expires_in_s": 3600 }).to_string();
    let r = full(env.ft_transfer_call(ONE_USDC, &msg).send_to(&env.net).await?);
    let text = r.logs().join(" | ");
    assert!(text.contains("new drops are paused") || !r.receipt_failures().is_empty(), "{text}");
    assert_eq!(env.usdc_balance(FUNDER).await?, funder_before, "the funder must be refunded");
    assert!(env.drop_view(&sk.public_key()).await?.is_none());
    assert!(!env.key_exists(&sk.public_key()).await);

    // the pending claim still works while paused
    env.claim(&link1, ALICE).await?.assert_success();
    assert_eq!(env.usdc_balance(ALICE).await?, ONE_USDC);
    assert_eq!(env.status(&pk1).await?, "Claimed");

    // and so does a reclaim
    let expires = env.expires_at_ns(&pk2).await?;
    env.fast_forward_past(expires).await?;
    env.reclaim(&pk2, FUNDER).await?.assert_success();
    assert_eq!(env.status(&pk2).await?, "Reclaimed");
    assert_eq!(env.usdc_balance(FUNDER).await?, funder_before + 2 * ONE_USDC);

    // unpause: drops can be created again
    env.owner_call("unpause", OWNER).await?.assert_success();
    assert!(!env.config().await?.paused);
    let (_l3, pk3, _) = env.create_drop(ONE_USDC, 3600, None).await?;
    assert_eq!(env.status(&pk3).await?, "Open");
    Ok(())
}

#[tokio::test]
async fn a_non_owner_cannot_pause_or_change_config() -> TestResult {
    let env = TestEnv::new().await?;
    assert_failed_with(env.owner_call("pause", ALICE).await, "owner only");
    assert!(!env.config().await?.paused);
    let r = env
        .drop
        .call_function("set_config", json!({ "max_expiry_s": 120 }))
        .transaction()
        .with_signer(id(FUNDER), env.signer.clone())
        .send_to(&env.net)
        .await;
    assert_failed_with(r, "owner only");
    Ok(())
}

#[tokio::test]
async fn ft_on_transfer_from_a_non_token_predecessor_fails() -> TestResult {
    let env = TestEnv::new().await?;
    let sk = near_api::signer::generate_secret_key()?;
    let msg = json!({ "public_key": sk.public_key().to_string(), "expires_in_s": 3600 }).to_string();
    let r = env
        .drop
        .call_function(
            "ft_on_transfer",
            json!({ "sender_id": ALICE, "amount": ONE_USDC.to_string(), "msg": msg }),
        )
        .transaction()
        .with_signer(id(ALICE), env.signer.clone())
        .send_to(&env.net)
        .await;
    assert_failed_with(r, "only the configured token contract");
    assert!(env.drop_view(&sk.public_key()).await?.is_none());
    assert_eq!(env.stats().await?.drops_created, 0);
    Ok(())
}

#[tokio::test]
async fn a_reused_public_key_is_rejected_and_the_funder_refunded() -> TestResult {
    let env = TestEnv::new().await?;
    let (_link, pk, _) = env.create_drop(ONE_USDC, 3600, None).await?;
    let funder_before = env.usdc_balance(FUNDER).await?;

    let msg = json!({ "public_key": pk.to_string(), "expires_in_s": 3600 }).to_string();
    let r = full(env.ft_transfer_call(2 * ONE_USDC, &msg).send_to(&env.net).await?);
    let text = format!("{:?} {}", r.receipt_failures(), r.logs().join(" | "));
    assert!(text.contains("public key already used"), "{text}");
    assert_eq!(env.usdc_balance(FUNDER).await?, funder_before, "refunded");
    assert_eq!(env.usdc_balance(DROP).await?, ONE_USDC);
    let d = env.drop_view(&pk).await?.expect("original drop");
    assert_eq!(d.amount, ONE_USDC.to_string());
    assert_eq!(env.stats().await?.drops_created, 1);

    // an invalid msg is refunded the same way
    let r = full(env.ft_transfer_call(ONE_USDC, "{\"expires_in_s\":3600}").send_to(&env.net).await?);
    assert!(!r.receipt_failures().is_empty());
    assert_eq!(env.usdc_balance(FUNDER).await?, funder_before);
    Ok(())
}

#[tokio::test]
async fn claim_to_a_new_named_account_through_the_root_linkdrop() -> TestResult {
    let env = TestEnv::new().await?;
    assert_eq!(env.config().await?.root_account_id, id(ROOT));
    let (link, pk, _) = env.create_drop(7 * ONE_USDC, 3600, None).await?;
    let new_sk = near_api::signer::generate_secret_key()?;
    let new_pk = new_sk.public_key();
    let new_id = "fresh.testnet";
    assert!(!env.account_exists(new_id).await);

    // a taken name: the root answers false, the drop reopens, the key survives
    assert!(env.account_exists(ALICE).await);
    env.sandbox
        .create_account("taken.testnet".parse()?)
        .initial_balance(NearToken::from_near(1))
        .send()
        .await?;
    let pool_before = env.near_balance(DROP).await?;
    let r = env.claim_to_new_account(&link, "taken.testnet", &new_pk).await?.assert_success();
    assert!(r.logs().iter().any(|l| l.contains("drop reopened")), "{:?}", r.logs());
    assert_eq!(env.status(&pk).await?, "Open");
    assert!(env.key_exists(&pk).await);
    assert_eq!(env.usdc_balance("taken.testnet").await?, 0);
    assert_eq!(env.near_balance("taken.testnet").await?, NearToken::from_near(1), "no starter for a taken name");
    let pool_after = env.near_balance(DROP).await?;
    let lost = pool_before.as_yoctonear().saturating_sub(pool_after.as_yoctonear());
    assert!(lost < STARTER, "the root refunds the starter when the name is taken: lost {lost}");

    // a deep name is refused before anything happens
    assert_failed_with(
        env.claim_to_new_account(&link, "a.b.testnet", &new_pk).await,
        "must be <name>.<root_account_id>",
    );

    // the happy path
    let ok = env.claim_to_new_account(&link, new_id, &new_pk).await?.assert_success();
    println!("GAS claim_to_new_account: {}", ok.total_gas_burnt);
    assert!(ok.receipt_failures().is_empty(), "{:?}", ok.receipt_failures());
    assert!(env.account_exists(new_id).await, "named account created through the root");
    assert_eq!(env.near_balance(new_id).await?, NearToken::from_yoctonear(STARTER), "the new named account holds exactly the starter");
    assert_eq!(env.usdc_balance(new_id).await?, 7 * ONE_USDC);
    let key = Account(id(new_id)).access_key(new_pk).fetch_from(&env.net).await?.data;
    assert!(format!("{:?}", key.permission).contains("FullAccess"));
    let d = env.drop_view(&pk).await?.expect("drop");
    assert_eq!(d.status, "Claimed");
    assert_eq!(d.claimed_to, Some(id(new_id)));
    assert!(!env.key_exists(&pk).await);
    Ok(())
}

#[tokio::test]
async fn claim_to_a_missing_named_account_reopens_the_drop_and_a_retry_works() -> TestResult {
    let env = TestEnv::new().await?;
    let (link, pk, _) = env.create_drop(ONE_USDC, 3600, None).await?;

    let r = env.claim(&link, "nobody.sandbox").await?.assert_success();
    assert!(r.logs().iter().any(|l| l.contains("drop reopened")), "{:?}", r.logs());
    assert_eq!(env.status(&pk).await?, "Open");
    assert_eq!(env.usdc_balance(DROP).await?, ONE_USDC, "the USDC never left");
    assert!(env.key_exists(&pk).await);
    assert_eq!(env.stats().await?.drops_claimed, 0);

    // same link, correct account
    env.claim(&link, ALICE).await?.assert_success();
    assert_eq!(env.status(&pk).await?, "Claimed");
    assert_eq!(env.usdc_balance(ALICE).await?, ONE_USDC);
    Ok(())
}

#[tokio::test]
async fn anyone_can_top_up_the_pool_and_the_owner_can_change_config() -> TestResult {
    let env = TestEnv::new().await?;
    let before = env.near_balance(DROP).await?;
    let ok = env
        .drop
        .call_function("top_up", json!({}))
        .transaction()
        .deposit(NearToken::from_near(3))
        .with_signer(id(BOB), env.signer.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    assert!(has_event(&ok, "pool_topped_up"));
    let after = env.near_balance(DROP).await?;
    assert!(after.as_yoctonear() - before.as_yoctonear() >= NearToken::from_near(3).as_yoctonear() - NearToken::from_millinear(10).as_yoctonear());

    let cfg = env.config().await?;
    assert_eq!(cfg.starter_yocto, STARTER.to_string());
    assert_eq!(cfg.min_amount, MIN_AMOUNT.to_string());
    env.drop
        .call_function(
            "set_config",
            json!({ "max_expiry_s": 120, "starter_yocto": "5", "min_amount": "6" }),
        )
        .transaction()
        .with_signer(id(OWNER), env.signer.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    let cfg = env.config().await?;
    assert_eq!((cfg.starter_yocto.as_str(), cfg.min_amount.as_str()), ("5", "6"));
    // a drop longer than the new maximum is refused and refunded
    let funder_before = env.usdc_balance(FUNDER).await?;
    let sk = near_api::signer::generate_secret_key()?;
    let msg = json!({ "public_key": sk.public_key().to_string(), "expires_in_s": 3600 }).to_string();
    let r = full(env.ft_transfer_call(ONE_USDC, &msg).send_to(&env.net).await?);
    assert!(!r.receipt_failures().is_empty());
    assert_eq!(env.usdc_balance(FUNDER).await?, funder_before);
    let (_l, pk, _) = env.create_drop(ONE_USDC, 120, None).await?;
    assert_eq!(env.status(&pk).await?, "Open");
    Ok(())
}

#[tokio::test]
async fn a_drop_below_min_amount_is_returned_without_a_panic_or_a_record() -> TestResult {
    let env = TestEnv::new().await?;
    let funder_before = env.usdc_balance(FUNDER).await?;
    let sk = near_api::signer::generate_secret_key()?;
    let msg = json!({ "public_key": sk.public_key().to_string(), "expires_in_s": 3600 }).to_string();

    let r = full(env.ft_transfer_call(MIN_AMOUNT - 1, &msg).send_to(&env.net).await?);
    assert!(r.receipt_failures().is_empty(), "panic-free: {:?}", r.receipt_failures());
    assert!(r.logs().iter().any(|l| l.contains("below min_amount")), "{:?}", r.logs());
    assert_eq!(env.usdc_balance(FUNDER).await?, funder_before, "tokens returned");
    assert_eq!(env.usdc_balance(DROP).await?, 0);
    assert!(env.drop_view(&sk.public_key()).await?.is_none(), "no record");
    assert!(!env.key_exists(&sk.public_key()).await, "no key");
    assert_eq!(env.stats().await?.drops_created, 0);

    // exactly the minimum is a real drop
    let (_l, pk, _) = env.create_drop(MIN_AMOUNT, 3600, None).await?;
    assert_eq!(env.status(&pk).await?, "Open");
    Ok(())
}

fn batch_msg(items: &[(&PublicKey, u128)], expires_in_s: u64) -> String {
    let drops: Vec<Value> = items
        .iter()
        .map(|(pk, a)| json!({ "public_key": pk.to_string(), "amount": a.to_string() }))
        .collect();
    json!({ "drops": drops, "expires_in_s": expires_in_s }).to_string()
}

#[tokio::test]
async fn a_batch_of_three_creates_three_claimable_drops_and_the_ledger_pages_newest_first() -> TestResult {
    let env = TestEnv::new().await?;
    let links = [TestEnv::new_link()?, TestEnv::new_link()?, TestEnv::new_link()?];
    let items = [(&links[0].1, ONE_USDC), (&links[1].1, 2 * ONE_USDC), (&links[2].1, 3 * ONE_USDC)];
    let ok = env
        .ft_transfer_call(6 * ONE_USDC, &batch_msg(&items, 3600))
        .send_to(&env.net)
        .await?
        .assert_success();
    println!("GAS batch create of 3: {}", ok.total_gas_burnt);
    assert!(ok.receipt_failures().is_empty(), "{:?}", ok.receipt_failures());
    assert_eq!(ok.logs().iter().filter(|l| l.contains("\"event\":\"drop_created\"")).count(), 3);
    for (_, pk) in &links {
        env.wait_for_key(pk).await?;
        assert_eq!(env.status(pk).await?, "Open");
    }
    assert_eq!(env.usdc_balance(DROP).await?, 6 * ONE_USDC);
    let s = env.stats().await?;
    assert_eq!((s.drops_created, s.open_drops), (3, 3));
    assert_eq!(s.total_amount_created, (6 * ONE_USDC).to_string());

    // the ledger: newest first, paged
    let keys = |v: Vec<DropView>| v.into_iter().map(|d| d.public_key).collect::<Vec<_>>();
    let want = vec![links[2].1.to_string(), links[1].1.to_string(), links[0].1.to_string()];
    assert_eq!(keys(env.drops_page(None, None).await?), want);
    assert_eq!(keys(env.drops_page(Some(1), Some(1)).await?), vec![links[1].1.to_string()]);
    assert_eq!(keys(env.drops_by_funder(FUNDER, None, None).await?), want);
    assert!(env.drops_by_funder(ALICE, None, None).await?.is_empty());
    let first = &env.drops_page(None, Some(1)).await?[0];
    assert_eq!(first.amount, (3 * ONE_USDC).to_string());
    assert_eq!(first.status, "Open");
    assert!(first.created_at_ns.parse::<u64>()? > 0 && first.status_changed_at_ns.parse::<u64>()? > 0);

    // every drop of the batch is claimable on its own
    env.claim(&links[0].0, ALICE).await?.assert_success();
    env.claim(&links[1].0, BOB).await?.assert_success();
    let implicit = implicit_account_for(&near_api::signer::generate_secret_key()?.public_key());
    env.claim(&links[2].0, &implicit).await?.assert_success();
    assert_eq!(env.usdc_balance(ALICE).await?, ONE_USDC);
    assert_eq!(env.usdc_balance(BOB).await?, 2 * ONE_USDC);
    assert_eq!(env.usdc_balance(&implicit).await?, 3 * ONE_USDC);
    let s = env.stats().await?;
    assert_eq!((s.drops_claimed, s.open_drops), (3, 0));
    assert_eq!(s.total_amount_claimed, (6 * ONE_USDC).to_string());
    assert!(env.drops_page(None, None).await?.iter().all(|d| d.status == "Claimed"));
    Ok(())
}

#[tokio::test]
async fn a_batch_whose_amounts_do_not_sum_to_the_transfer_is_refunded() -> TestResult {
    let env = TestEnv::new().await?;
    let funder_before = env.usdc_balance(FUNDER).await?;
    let links = [TestEnv::new_link()?, TestEnv::new_link()?, TestEnv::new_link()?];
    let items = [(&links[0].1, ONE_USDC), (&links[1].1, 2 * ONE_USDC), (&links[2].1, 3 * ONE_USDC)];
    let r = full(env.ft_transfer_call(5 * ONE_USDC, &batch_msg(&items, 3600)).send_to(&env.net).await?);
    assert!(r.receipt_failures().is_empty(), "panic-free: {:?}", r.receipt_failures());
    assert!(r.logs().iter().any(|l| l.contains("amounts sum to")), "{:?}", r.logs());
    assert_eq!(env.usdc_balance(FUNDER).await?, funder_before, "everything returned");
    assert_eq!(env.usdc_balance(DROP).await?, 0);
    for (_, pk) in &links {
        assert!(env.drop_view(pk).await?.is_none());
        assert!(!env.key_exists(pk).await);
    }
    assert_eq!(env.stats().await?.drops_created, 0);
    assert!(env.drops_page(None, None).await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn a_batch_with_one_reused_key_is_refunded_entirely() -> TestResult {
    let env = TestEnv::new().await?;
    let (_link0, pk0, _) = env.create_drop(ONE_USDC, 3600, None).await?;
    let funder_before = env.usdc_balance(FUNDER).await?;
    let (_, pk_a) = TestEnv::new_link()?;
    let (_, pk_b) = TestEnv::new_link()?;
    let items = [(&pk0, ONE_USDC), (&pk_a, ONE_USDC), (&pk_b, ONE_USDC)];
    let r = full(env.ft_transfer_call(3 * ONE_USDC, &batch_msg(&items, 3600)).send_to(&env.net).await?);
    assert!(r.receipt_failures().is_empty(), "panic-free: {:?}", r.receipt_failures());
    assert!(r.logs().iter().any(|l| l.contains("already used")), "{:?}", r.logs());
    assert_eq!(env.usdc_balance(FUNDER).await?, funder_before);
    assert!(env.drop_view(&pk_a).await?.is_none() && env.drop_view(&pk_b).await?.is_none());
    assert!(!env.key_exists(&pk_a).await && !env.key_exists(&pk_b).await);
    let original = env.drop_view(&pk0).await?.expect("original drop intact");
    assert_eq!((original.status.as_str(), original.amount.as_str()), ("Open", &*ONE_USDC.to_string()));
    assert_eq!(env.stats().await?.drops_created, 1);
    Ok(())
}

#[tokio::test]
async fn a_batch_of_thirty_drops_fits_in_gas() -> TestResult {
    let env = TestEnv::new().await?;
    let mut links = Vec::new();
    for _ in 0..30 {
        links.push(TestEnv::new_link()?);
    }
    let items: Vec<(&PublicKey, u128)> = links.iter().map(|(_, pk)| (pk, MIN_AMOUNT)).collect();
    let total = 30 * MIN_AMOUNT;
    let ok = env
        .ft_transfer_call_with_gas(total, &batch_msg(&items, 3600), 300)
        .send_to(&env.net)
        .await?
        .assert_success();
    assert!(ok.receipt_failures().is_empty(), "{:?}", ok.receipt_failures());
    let heaviest = ok
        .receipt_outcomes()
        .iter()
        .map(|o| o.gas_burnt)
        .max_by_key(|g| g.as_gas())
        .expect("receipts");
    println!("GAS batch create of 30: whole tx {} / heaviest receipt (ft_on_transfer) {}", ok.total_gas_burnt, heaviest);
    assert_eq!(ok.logs().iter().filter(|l| l.contains("\"event\":\"drop_created\"")).count(), 30);
    for (_, pk) in &links {
        env.wait_for_key(pk).await?;
    }
    assert_eq!(env.usdc_balance(DROP).await?, total);
    let s = env.stats().await?;
    assert_eq!((s.drops_created, s.open_drops), (30, 30));
    assert_eq!(env.drops_page(None, Some(100)).await?.len(), 30);
    assert_eq!(env.drops_page(Some(25), Some(10)).await?.len(), 5);
    assert_eq!(env.drops_by_funder(FUNDER, Some(10), Some(10)).await?.len(), 10);
    Ok(())
}



// ---------------------------------------------------------------------------
// Returns: unclaimed money goes home without the funder

#[tokio::test]
async fn an_armed_link_nobody_opens_comes_home_by_itself() -> TestResult {
    let env = TestEnv::new().await?;
    let (link, pk, _) = env.create_drop(3 * ONE_USDC, 60, Some("rent")).await?;
    let storage_before = env.storage_usage(DROP).await?;
    // a stranger arms the timer; from here on nobody signs anything
    let bob_before = env.near_balance(BOB).await?;
    env.arm(&[pk], BOB, 300).await?;
    let storage_armed = env.storage_usage(DROP).await?;
    println!("escrow storage before arming {storage_before} bytes, with a pending timer {storage_armed} bytes");
    assert_eq!(env.status(&pk).await?, "Open", "arming moves nothing");

    let expires = env.expires_at_ns(&pk).await?;
    env.wait_for_status(&[pk], "Reclaimed", 30).await?;
    env.wait_for_returned(1).await?;
    let d = env.drop_view(&pk).await?.ok_or("drop")?;
    let returned_at: u64 = d.status_changed_at_ns.parse()?;
    assert!(returned_at >= expires, "the money went home only after the expiry");
    println!("returned {} s of chain time after the expiry", (returned_at - expires) / NS_PER_S);

    assert_eq!(env.usdc_balance(FUNDER).await?, FUNDER_SUPPLY, "the funder has every dollar back");
    assert_eq!(env.usdc_balance(DROP).await?, 0);
    assert!(!env.key_exists(&pk).await, "the link key is deleted");
    let s = env.stats().await?;
    assert_eq!((s.drops_reclaimed, s.open_drops), (1, 0));
    assert_eq!(s.total_amount_reclaimed, (3 * ONE_USDC).to_string());
    assert!(!failure_text(env.claim(&link, ALICE).await).is_empty(), "the dead link cannot be claimed");

    // what the whole timer cost the account that armed it, once the unused gas came back
    env.sandbox.fast_forward(20).await?;
    let spent = bob_before.as_yoctonear().saturating_sub(env.near_balance(BOB).await?.as_yoctonear());
    println!("COST of arming, every wake-up and the return, paid by the arming account: {:.6} NEAR", spent as f64 / 1e24);
    assert!(spent < NearToken::from_millinear(50).as_yoctonear(), "a timer must cost cents: {spent}");
    Ok(())
}

#[tokio::test]
async fn a_timer_wakes_by_itself_every_200_blocks_and_costs_little_gas() -> TestResult {
    let env = TestEnv::new().await?;
    let (link, pk, _) = env.create_drop(ONE_USDC, 3600, None).await?;
    let funder_before = env.near_balance(FUNDER).await?;
    let start = env.height().await?;
    env.arm(&[pk], FUNDER, 300).await?;
    // about ten wake-ups pass with nobody acting; the link stays open and claimable
    for _ in 0..21 {
        env.sandbox.fast_forward(100).await?;
    }
    assert_eq!(env.status(&pk).await?, "Open");
    // the claim ends the timer at its next wake-up
    env.claim(&link, ALICE).await?.assert_success();
    for _ in 0..3 {
        env.sandbox.fast_forward(100).await?;
    }
    assert_eq!(env.usdc_balance(ALICE).await?, ONE_USDC);
    assert_eq!(env.status(&pk).await?, "Claimed", "a claimed link is never returned");
    assert_eq!(env.usdc_balance(FUNDER).await?, FUNDER_SUPPLY - ONE_USDC, "nothing went back to the funder");

    // the cost: everything the timer burnt, read from the arming account once its gas came back
    env.sandbox.fast_forward(20).await?;
    let blocks = env.height().await?.saturating_sub(start);
    let spent = funder_before.as_yoctonear().saturating_sub(env.near_balance(FUNDER).await?.as_yoctonear());
    let price = env.gas_price().await?;
    let tgas = spent as f64 / price as f64 / 1e12;
    let wakeups = (blocks / 200).max(1);
    println!(
        "COST of a timer over {blocks} blocks (about {wakeups} wake-ups): {:.6} NEAR = {tgas:.1} Tgas at {price} yocto/gas, about {:.2} Tgas a wake-up",
        spent as f64 / 1e24,
        tgas / wakeups as f64
    );
    assert!(tgas / (wakeups as f64) < 5.0, "a wake-up should cost a few Tgas");
    Ok(())
}

#[tokio::test]
async fn a_second_timer_for_the_same_link_is_refused_while_the_first_runs() -> TestResult {
    let env = TestEnv::new().await?;
    let (_link, pk, _) = env.create_drop(ONE_USDC, 3600, None).await?;
    env.arm(&[pk], FUNDER, 300).await?;
    assert_failed_with(env.arm_final(&[pk], BOB, 300).await, "already armed");
    // too little gas for even one return is refused before anything is armed
    let (_l2, pk2, _) = env.create_drop(ONE_USDC, 3600, None).await?;
    assert_failed_with(env.arm_final(&[pk2], BOB, 30).await, "attach more gas");
    Ok(())
}

#[tokio::test]
async fn an_armed_batch_returns_what_nobody_claimed_in_one_transfer_and_a_claim_stays_paid() -> TestResult {
    let env = TestEnv::new().await?;
    let links = [TestEnv::new_link()?, TestEnv::new_link()?, TestEnv::new_link()?];
    let items = [(&links[0].1, ONE_USDC), (&links[1].1, 2 * ONE_USDC), (&links[2].1, 3 * ONE_USDC)];
    env.ft_transfer_call(6 * ONE_USDC, &batch_msg(&items, 60)).send_to(&env.net).await?.assert_success();
    for (_, pk) in &links {
        env.wait_for_key(pk).await?;
    }
    let keys: Vec<PublicKey> = links.iter().map(|(_, pk)| *pk).collect();
    env.arm(&keys, FUNDER, 300).await?;
    env.claim(&links[0].0, ALICE).await?.assert_success();

    env.wait_for_status(&keys[1..], "Reclaimed", 30).await?;
    env.wait_for_returned(2).await?;
    assert_eq!(env.status(&keys[0]).await?, "Claimed");
    assert_eq!(env.usdc_balance(ALICE).await?, ONE_USDC);
    assert_eq!(env.usdc_balance(FUNDER).await?, FUNDER_SUPPLY - ONE_USDC);
    assert_eq!(env.usdc_balance(DROP).await?, 0);
    let s = env.stats().await?;
    assert_eq!((s.drops_claimed, s.drops_reclaimed, s.open_drops), (1, 2, 0));
    assert_eq!(s.total_amount_reclaimed, (5 * ONE_USDC).to_string());
    for k in &keys {
        assert!(!env.key_exists(k).await, "every link key is deleted");
    }
    Ok(())
}

#[tokio::test]
async fn a_timer_returns_thirty_unclaimed_links_in_one_transfer() -> TestResult {
    let env = TestEnv::new().await?;
    let mut links = Vec::new();
    for _ in 0..30 {
        links.push(TestEnv::new_link()?);
    }
    let items: Vec<(&PublicKey, u128)> = links.iter().map(|(_, pk)| (pk, MIN_AMOUNT)).collect();
    env.ft_transfer_call_with_gas(30 * MIN_AMOUNT, &batch_msg(&items, 60), 300)
        .send_to(&env.net)
        .await?
        .assert_success();
    for (_, pk) in &links {
        env.wait_for_key(pk).await?;
    }
    let keys: Vec<PublicKey> = links.iter().map(|(_, pk)| *pk).collect();
    env.arm(&keys, FUNDER, 300).await?;
    env.wait_for_status(&keys, "Reclaimed", 30).await?;
    env.wait_for_returned(30).await?;
    assert_eq!(env.usdc_balance(FUNDER).await?, FUNDER_SUPPLY);
    assert_eq!(env.usdc_balance(DROP).await?, 0);
    let s = env.stats().await?;
    assert_eq!((s.drops_reclaimed, s.open_drops), (30, 0));
    assert_eq!(s.total_amount_reclaimed, (30 * MIN_AMOUNT).to_string());
    for k in &keys {
        assert!(!env.key_exists(k).await, "every link key is deleted");
    }
    Ok(())
}

#[tokio::test]
async fn a_stranger_can_only_send_expired_unclaimed_links_back_to_their_funder() -> TestResult {
    let env = TestEnv::new().await?;
    let links = [TestEnv::new_link()?, TestEnv::new_link()?, TestEnv::new_link()?];
    let items = [(&links[0].1, ONE_USDC), (&links[1].1, 2 * ONE_USDC), (&links[2].1, 3 * ONE_USDC)];
    env.ft_transfer_call(6 * ONE_USDC, &batch_msg(&items, 60)).send_to(&env.net).await?.assert_success();
    for (_, pk) in &links {
        env.wait_for_key(pk).await?;
    }
    let (pk0, pk1, pk2) = (links[0].1, links[1].1, links[2].1);
    env.claim(&links[0].0, ALICE).await?.assert_success();

    assert_failed_with(env.return_expired(&[pk1, pk2], BOB).await, "has not expired yet");
    env.fast_forward_past(env.expires_at_ns(&pk1).await?).await?;
    // a stranger still cannot reclaim, and a claimed link cannot be returned
    assert_failed_with(env.reclaim(&pk1, BOB).await, "only the funder may reclaim");
    assert_failed_with(env.return_expired(&[pk0, pk1], BOB).await, "drop already claimed");

    let bob_usdc = env.usdc_balance(BOB).await?;
    let ok = env.return_expired(&[pk1, pk2], BOB).await?.assert_success();
    println!("GAS return_expired of two links: {}", ok.total_gas_burnt);
    assert!(ok.receipt_failures().is_empty(), "{:?}", ok.receipt_failures());
    assert_eq!(ok.logs().iter().filter(|l| l.contains("\"event\":\"drop_reclaimed\"") && l.contains("\"by\":\"bob.sandbox\"")).count(), 2);
    assert_eq!(env.usdc_balance(FUNDER).await?, FUNDER_SUPPLY - ONE_USDC, "the money went to the funder");
    assert_eq!(env.usdc_balance(BOB).await?, bob_usdc, "and not a cent to the caller");
    assert_eq!(env.usdc_balance(DROP).await?, 0);
    assert!(!env.key_exists(&pk1).await && !env.key_exists(&pk2).await);
    assert_failed_with(env.return_expired(&[pk1], BOB).await, "drop already reclaimed");
    Ok(())
}
