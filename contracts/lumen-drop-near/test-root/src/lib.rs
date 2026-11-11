//! Mock of the `create_account` method of the root linkdrop accounts
//! (`testnet` on testnet, `near` on mainnet) for the lumenia-drop sandbox
//! tests. Mirrors near/near-linkdrop: creates the sub-account with the given
//! full-access key, forwards the attached deposit, and answers `true` or
//! `false` from its callback (refunding the deposit on failure).

use near_sdk::{AccountId, Gas, NearToken, Promise, PublicKey, env, near};

#[near(contract_state)]
#[derive(Default)]
pub struct Contract {}

#[near]
impl Contract {
    #[payable]
    pub fn create_account(&mut self, new_account_id: AccountId, new_public_key: PublicKey) -> Promise {
        let amount = env::attached_deposit();
        Promise::new(new_account_id)
            .create_account()
            .add_full_access_key(new_public_key)
            .transfer(amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(5))
                    .on_account_created(env::predecessor_account_id(), amount),
            )
    }

    #[private]
    pub fn on_account_created(&mut self, predecessor_account_id: AccountId, amount: NearToken) -> bool {
        let created = env::promise_result_checked(0, 64).is_ok();
        if !created && amount > NearToken::from_yoctonear(0) {
            Promise::new(predecessor_account_id).transfer(amount).detach();
        }
        created
    }
}
