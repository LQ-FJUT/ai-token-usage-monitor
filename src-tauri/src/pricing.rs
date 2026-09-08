//! Offline, conservative standard-API price catalogue.
//!
//! The catalogue is deliberately local and date-stamped.  It estimates only
//! text-token charges which can be proven from the locally indexed usage
//! fields; unknown models and non-standard billing conditions remain visible
//! as unpriced rather than being guessed.

use chrono::{Datelike, Timelike, Utc};
use serde::Serialize;

pub(crate) const PRICE_SNAPSHOT_DATE: &str = "2026-08-29";

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct PriceUsage {
    pub(crate) input_tokens: i64,
    pub(crate) cached_input_tokens: i64,
    pub(crate) cache_write_5m_tokens: i64,
    pub(crate) cache_write_1h_tokens: i64,
    pub(crate) cache_write_unknown_tokens: i64,
    pub(crate) output_tokens: i64,
    pub(crate) total_tokens: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CostSummary {
    pub(crate) usd: f64,
    pub(crate) cny: f64,
    pub(crate) unpriced_tokens: i64,
}

impl CostSummary {
    pub(crate) fn add_assign(&mut self, other: &Self) {
        self.usd += other.usd;
        self.cny += other.cny;
        self.unpriced_tokens += other.unpriced_tokens;
    }
}

#[derive(Clone, Copy)]
enum Currency {
    Usd,
    Cny,
}

#[derive(Clone, Copy)]
struct Rates {
    currency: Currency,
    input: f64,
    cached: f64,
    output: f64,
    cache_write_5m: Option<f64>,
    cache_write_1h: Option<f64>,
    cache_write_unknown: Option<f64>,
}

impl Rates {
    fn standard(currency: Currency, input: f64, cached: f64, output: f64) -> Self {
        Self {
            currency,
            input,
            cached,
            output,
            cache_write_5m: None,
            cache_write_1h: None,
            cache_write_unknown: None,
        }
    }

    fn estimate(self, usage: PriceUsage) -> CostSummary {
        let mut amount = ((usage.input_tokens.max(0) as f64 * self.input)
            + (usage.cached_input_tokens.max(0) as f64 * self.cached)
            + (usage.output_tokens.max(0) as f64 * self.output))
            / 1_000_000.0;
        let mut unpriced = usage.cache_write_unknown_tokens.max(0);

        for (tokens, rate) in [
            (usage.cache_write_5m_tokens.max(0), self.cache_write_5m),
            (usage.cache_write_1h_tokens.max(0), self.cache_write_1h),
        ] {
            if let Some(rate) = rate {
                amount += tokens as f64 * rate / 1_000_000.0;
            } else {
                unpriced += tokens;
            }
        }
        if let Some(rate) = self.cache_write_unknown {
            amount += usage.cache_write_unknown_tokens.max(0) as f64 * rate / 1_000_000.0;
            unpriced -= usage.cache_write_unknown_tokens.max(0);
        }

        match self.currency {
            Currency::Usd => CostSummary {
                usd: amount,
                cny: 0.0,
                unpriced_tokens: unpriced,
            },
            Currency::Cny => CostSummary {
                usd: 0.0,
                cny: amount,
                unpriced_tokens: unpriced,
            },
        }
    }
}

/// Uses the standard direct-API text price for one indexed event.  The caller
/// must provide the event time so DeepSeek peak pricing is not guessed.
pub(crate) fn estimate(
    model_label: &str,
    usage: PriceUsage,
    occurred_at_ms: Option<i64>,
) -> CostSummary {
    let model = model_label.trim().to_ascii_lowercase();
    if model.is_empty() || model == "<synthetic>" || model.contains("unknown") {
        return CostSummary {
            unpriced_tokens: usage.total_tokens.max(0),
            ..CostSummary::default()
        };
    }

    let rates = if matches!(model.as_str(), "gpt-5.6" | "gpt-5.6-sol") {
        openai(4.0, 0.4, 20.0)
    } else if model == "gpt-5.6-terra" {
        openai(2.0, 0.2, 12.0)
    } else if model == "gpt-5.6-luna" {
        openai(0.2, 0.02, 1.2)
    } else if model == "gpt-5.6-cyber" {
        openai(12.5, 1.25, 75.0)
    } else if matches!(model.as_str(), "kimi-k3" | "kimi_k3") {
        Rates::standard(Currency::Cny, 20.0, 2.0, 100.0)
    } else if model == "hy3" {
        Rates::standard(Currency::Cny, 1.0, 0.25, 4.0)
    } else if model == "hy3-preview" {
        hy3_preview(usage)
    } else if matches!(
        model.as_str(),
        "deepseek-v4-flash" | "deepseek-v4-pro" | "deepseek-v4-flash-vision-exp"
    ) {
        let Some(rates) = deepseek_rates(&model, occurred_at_ms) else {
            return CostSummary {
                unpriced_tokens: usage.total_tokens.max(0),
                ..CostSummary::default()
            };
        };
        rates
    } else if let Some(rates) = claude_rates(&model) {
        rates
    } else {
        return CostSummary {
            unpriced_tokens: usage.total_tokens.max(0),
            ..CostSummary::default()
        };
    };

    // The standard table is not sufficient for these documented special tiers.
    // Keeping the event unpriced is more honest than guessing a billable tier.
    let total_input = usage.input_tokens.max(0)
        + usage.cached_input_tokens.max(0)
        + usage.cache_write_5m_tokens.max(0)
        + usage.cache_write_1h_tokens.max(0)
        + usage.cache_write_unknown_tokens.max(0);
    if (model.starts_with("gpt-5.6") && total_input > 272_000)
        || (model.contains("claude-sonnet-4") && total_input > 200_000)
        || model.contains("vision")
    {
        return CostSummary {
            unpriced_tokens: usage.total_tokens.max(0),
            ..CostSummary::default()
        };
    }
    rates.estimate(usage)
}

fn openai(input: f64, cached: f64, output: f64) -> Rates {
    let mut rates = Rates::standard(Currency::Usd, input, cached, output);
    rates.cache_write_unknown = Some(input * 1.25);
    rates
}

fn hy3_preview(usage: PriceUsage) -> Rates {
    let input_length = usage.input_tokens.max(0)
        + usage.cached_input_tokens.max(0)
        + usage.cache_write_5m_tokens.max(0)
        + usage.cache_write_1h_tokens.max(0)
        + usage.cache_write_unknown_tokens.max(0);
    if input_length < 16_000 {
        Rates::standard(Currency::Cny, 1.2, 0.4, 4.0)
    } else if input_length < 32_000 {
        Rates::standard(Currency::Cny, 1.6, 0.6, 6.4)
    } else {
        Rates::standard(Currency::Cny, 2.0, 0.8, 8.0)
    }
}

fn deepseek_rates(model: &str, occurred_at_ms: Option<i64>) -> Option<Rates> {
    let time = occurred_at_ms.and_then(chrono::DateTime::<Utc>::from_timestamp_millis)?;
    let peak = {
        let weekday = time.weekday().number_from_monday();
        let hour = time.hour();
        weekday <= 5 && ((1..4).contains(&hour) || (6..10).contains(&hour))
    };
    let pro = model.contains("v4-pro");
    let (input, cached, output) = match (pro, peak) {
        (false, false) => (0.22, 0.007, 0.66),
        (false, true) => (0.44, 0.014, 1.32),
        (true, false) => (0.66, 0.022, 1.98),
        (true, true) => (1.32, 0.044, 3.96),
    };
    Some(Rates::standard(Currency::Usd, input, cached, output))
}

fn claude_rates(model: &str) -> Option<Rates> {
    if !model.starts_with("claude-") {
        return None;
    }
    let (input, cached, output) = if model.contains("opus-4-1")
        || model.contains("opus-4.1")
        || model.contains("opus-4")
        || model.contains("opus-3")
    {
        (15.0, 1.5, 75.0)
    } else if model.contains("sonnet-4")
        || model.contains("sonnet-3-7")
        || model.contains("sonnet-3.7")
        || model.contains("sonnet-3-5")
        || model.contains("sonnet-3.5")
    {
        (3.0, 0.3, 15.0)
    } else if model.contains("haiku-3-5") || model.contains("haiku-3.5") {
        (0.8, 0.08, 4.0)
    } else if model.contains("haiku-3") {
        (0.25, 0.03, 1.25)
    } else {
        return None;
    };
    let mut rates = Rates::standard(Currency::Usd, input, cached, output);
    rates.cache_write_5m = Some(input * 1.25);
    rates.cache_write_1h = Some(input * 2.0);
    Some(rates)
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn usage() -> PriceUsage {
        PriceUsage {
            input_tokens: 1_000_000,
            cached_input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            total_tokens: 3_000_000,
            ..PriceUsage::default()
        }
    }

    fn small_usage() -> PriceUsage {
        PriceUsage {
            input_tokens: 1_000,
            cached_input_tokens: 1_000,
            output_tokens: 1_000,
            total_tokens: 3_000,
            ..PriceUsage::default()
        }
    }

    #[test]
    fn prices_gpt_sol_and_cache_write() {
        let mut sample = small_usage();
        sample.cache_write_unknown_tokens = 1_000;
        sample.total_tokens += 1_000;
        let cost = estimate("gpt-5.6-sol", sample, Some(1_788_000_000_000));
        assert!((cost.usd - 0.0294).abs() < 0.000_001);
        assert_eq!(cost.unpriced_tokens, 0);
    }

    #[test]
    fn deepseek_uses_event_peak_window() {
        let instant = Utc
            .with_ymd_and_hms(2026, 8, 24, 1, 0, 0)
            .single()
            .expect("valid UTC time")
            .timestamp_millis();
        let peak = estimate("deepseek-v4-flash", usage(), Some(instant));
        assert!((peak.usd - 1.774).abs() < 0.000_001);
    }

    #[test]
    fn claude_keeps_unknown_cache_write_unpriced() {
        let mut sample = small_usage();
        sample.cache_write_unknown_tokens = 12;
        let cost = estimate("claude-sonnet-4-20250514", sample, Some(1));
        assert_eq!(cost.unpriced_tokens, 12);
    }

    #[test]
    fn keeps_currencies_separate_and_cache_writes_unpriced_when_not_published() {
        let mut sample = small_usage();
        sample.cache_write_unknown_tokens = 100;
        sample.total_tokens += 100;
        let cost = estimate("kimi-k3", sample, Some(1));
        assert_eq!(cost.usd, 0.0);
        assert!((cost.cny - 0.122).abs() < 0.000_001);
        assert_eq!(cost.unpriced_tokens, 100);
    }

    #[test]
    fn applies_hy3_preview_input_length_tier() {
        let sample = PriceUsage {
            input_tokens: 16_000,
            output_tokens: 1_000,
            total_tokens: 17_000,
            ..PriceUsage::default()
        };
        let cost = estimate("hy3-preview", sample, Some(1));
        assert!((cost.cny - 0.032).abs() < 0.000_001);
    }

    #[test]
    fn applies_claude_dual_cache_write_rates() {
        let mut sample = small_usage();
        sample.cache_write_5m_tokens = 1_000;
        sample.cache_write_1h_tokens = 1_000;
        sample.total_tokens += 2_000;
        let cost = estimate("claude-sonnet-4-20250514", sample, Some(1));
        assert!((cost.usd - 0.02805).abs() < 0.000_001);
        assert_eq!(cost.unpriced_tokens, 0);
    }

    #[test]
    fn refuses_to_price_unknown_models_or_deepseek_without_time() {
        let sample = small_usage();
        assert_eq!(
            estimate("unlisted-model", sample, Some(1)).unpriced_tokens,
            3_000
        );
        assert_eq!(
            estimate("deepseek-v4-flash", sample, None).unpriced_tokens,
            3_000
        );
    }
}
