/// USD price book used for daily-spend and slippage checks.
///
/// v1 uses a dedicated price-updater key (`OracleCap`). That key must NOT live
/// on the AI agent's server: whoever moves prices can stretch the USD limit.
/// Production: replace `set_price` with a Pyth pull-oracle read (see
/// docs/SECURITY.md). The staleness check stays the same.
module wallet_policy::oracle;

use sui::clock::Clock;
use sui::table::{Self, Table};

const EStalePrice: u64 = 0;
const EUnknownAsset: u64 = 1;
const EWrongBook: u64 = 2;
const EZeroPrice: u64 = 3;

public struct PriceBook has key {
    id: UID,
    /// asset symbol (e.g. b"ETH", b"USDC") -> price
    prices: Table<vector<u8>, Price>,
}

public struct Price has copy, drop, store {
    /// USD price with 8 decimals.
    usd_e8: u64,
    updated_ms: u64,
}

public struct OracleCap has key, store {
    id: UID,
    book: ID,
}

/// Creates and shares a PriceBook; returns the updater cap.
public fun create(ctx: &mut TxContext): OracleCap {
    let book = PriceBook { id: object::new(ctx), prices: table::new(ctx) };
    let cap = OracleCap { id: object::new(ctx), book: object::id(&book) };
    transfer::share_object(book);
    cap
}

public fun set_price(
    book: &mut PriceBook,
    cap: &OracleCap,
    asset: vector<u8>,
    usd_e8: u64,
    clock: &Clock,
) {
    assert!(cap.book == object::id(book), EWrongBook);
    assert!(usd_e8 > 0, EZeroPrice);
    let price = Price { usd_e8, updated_ms: clock.timestamp_ms() };
    if (book.prices.contains(asset)) {
        let slot = &mut book.prices[asset];
        *slot = price;
    } else {
        book.prices.add(asset, price);
    }
}

/// Aborts if the asset is unknown or its price is older than `max_age_ms`.
public fun price_usd_e8(book: &PriceBook, asset: vector<u8>, max_age_ms: u64, clock: &Clock): u64 {
    assert!(book.prices.contains(asset), EUnknownAsset);
    let p = &book.prices[asset];
    assert!(clock.timestamp_ms() <= p.updated_ms + max_age_ms, EStalePrice);
    p.usd_e8
}

public fun book_id(book: &PriceBook): ID { object::id(book) }

#[test_only]
public fun destroy_cap_for_testing(cap: OracleCap) {
    let OracleCap { id, book: _ } = cap;
    id.delete();
}
