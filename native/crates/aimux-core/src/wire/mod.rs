//! The HTTP and scheduling plumbing both halves run on.
//!
//! This is transport mechanics -- parsing a request, preparing a response,
//! routing a URL, running periodic work -- and deliberately not the daemon's
//! decisions about any of it. Nothing here opens a socket: binding and
//! accepting stay in the local crate, so a reviewer reading this directory is
//! not reading network setup.

pub mod http;
pub mod routing;
pub mod scheduler;
pub mod server;
