use std::fmt::{Display, Formatter};
use std::io;

#[derive(Debug)]
pub enum IndexError {
    Io(io::Error),
    Sql(rusqlite::Error),
    UnsupportedSchema(i64),
    ForeignDatabase(i64),
    InvalidPath,
    InvalidState(&'static str),
}

pub type IndexResult<T> = Result<T, IndexError>;

impl Display for IndexError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "index I/O error: {error}"),
            Self::Sql(error) => write!(formatter, "index database error: {error}"),
            Self::UnsupportedSchema(version) => {
                write!(formatter, "unsupported index schema version {version}")
            }
            Self::ForeignDatabase(application_id) => {
                write!(
                    formatter,
                    "unexpected SQLite application id {application_id}"
                )
            }
            Self::InvalidPath => formatter.write_str("rollout path has no usable file name"),
            Self::InvalidState(message) => {
                write!(formatter, "invalid persisted parser state: {message}")
            }
        }
    }
}

impl std::error::Error for IndexError {}

impl From<io::Error> for IndexError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for IndexError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}
