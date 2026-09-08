//! Privacy-preserving, incremental index for Codex rollout JSONL files.
//!
//! This module deliberately exposes derived usage only. Raw JSON records,
//! prompts, responses, tool output, account identifiers, and absolute paths
//! are never written to SQLite.

mod error;
mod model;
mod parser;
mod schema;
mod store;

pub use error::{IndexError, IndexResult};
pub use model::{
    FileScanReport, LocalUsageEvent, LocalUsageSummary, ScanSummary, TokenUsage, UsageDimension,
};
pub(crate) use schema::{APPLICATION_ID, PARSER_SEMANTICS_VERSION, SCHEMA_VERSION};
pub use store::IncrementalIndex;

#[cfg(test)]
mod tests;
