//! The RAII tmux-query memo scope, which the dashboard frame loop holds.
//!
//! Rust-only, deliberately not added to `testdata/contracts/v1/tmux/query-memo.json`:
//! those cases are Node-parity fixtures carrying an `inputSha256` and a
//! `src/tmux/query-memo.test.ts` source, and `enter_tmux_query_memo` has no
//! Node counterpart. It exists because `with_tmux_query_memo` takes a closure
//! and the dashboard frame loop uses `continue`/`break`, which a closure cannot
//! carry.
//!
//! Why this matters at all: every read-only tmux verb already routes through
//! `memoized_tmux_query`, but the memo is SCOPED and nothing in `src/` ever
//! opened a scope -- so in the shipped binary it was a pure passthrough and
//! every call site re-exec'd.

use aimux::tmux_query_memo::{
    enter_tmux_query_memo, is_in_tmux_query_memo_scope, memoized_tmux_query,
};
use std::cell::RefCell;
use std::rc::Rc;

/// A compute that counts how many times it really ran.
fn counted(calls: &Rc<RefCell<usize>>, key: &str) -> String {
    let calls = Rc::clone(calls);
    memoized_tmux_query(key.to_owned(), move || {
        *calls.borrow_mut() += 1;
        Ok("value".to_owned())
    })
    .expect("query")
}

/// One scope answers a repeated query once, and the next scope asks again.
///
/// The second half is the half that matters for correctness: a frame must not
/// inherit the previous frame's answers, or a resized pane or a closed window
/// would never be noticed.
#[test]
fn a_frame_scope_asks_once_and_the_next_frame_asks_again() {
    let calls = Rc::new(RefCell::new(0));
    {
        let _frame = enter_tmux_query_memo();
        assert!(is_in_tmux_query_memo_scope(), "the scope is open");
        counted(&calls, "list-windows");
        counted(&calls, "list-windows");
        counted(&calls, "list-windows");
        assert_eq!(*calls.borrow(), 1, "three asks, one exec inside one frame");
    }
    assert!(
        !is_in_tmux_query_memo_scope(),
        "the scope closes when the frame value drops"
    );

    {
        let _next_frame = enter_tmux_query_memo();
        counted(&calls, "list-windows");
        assert_eq!(
            *calls.borrow(),
            2,
            "the next frame re-asks rather than trusting the last one"
        );
    }
}

/// Without a scope the memo is inert, which is what shipped.
#[test]
fn outside_a_scope_every_ask_execs() {
    let calls = Rc::new(RefCell::new(0));
    assert!(!is_in_tmux_query_memo_scope());
    counted(&calls, "list-sessions");
    counted(&calls, "list-sessions");
    assert_eq!(
        *calls.borrow(),
        2,
        "this is the shipped behaviour the dashboard was paying for"
    );
}

/// Entering while a scope is open must not close it early.
///
/// The frame loop can call into code that opens its own scope; if the inner
/// entry took ownership, its drop would end the frame's memo halfway through
/// and the rest of the frame would exec again.
#[test]
fn a_nested_scope_does_not_close_the_outer_one() {
    let calls = Rc::new(RefCell::new(0));
    let _frame = enter_tmux_query_memo();
    counted(&calls, "display-message");
    {
        let _inner = enter_tmux_query_memo();
        counted(&calls, "display-message");
    }
    assert!(
        is_in_tmux_query_memo_scope(),
        "the outer frame scope survives the inner one"
    );
    counted(&calls, "display-message");
    assert_eq!(
        *calls.borrow(),
        1,
        "one exec across the whole frame, nesting included"
    );
}
