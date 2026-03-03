use std::sync::OnceLock;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

static WHISPER_CTX: OnceLock<WhisperContext> = OnceLock::new();

const CHUNK_SIZE: usize = 16000 * 60 * 5;
const CHUNK_OVERLAP: usize = 16000;

pub fn init_model(model_path: &str) -> Result<(), String> {
    if WHISPER_CTX.get().is_some() {
        return Ok(());
    }

    let mut ctx_params = WhisperContextParameters::default();
    ctx_params.use_gpu(cfg!(feature = "cuda"));
    ctx_params.flash_attn(cfg!(feature = "cuda"));

    let ctx = WhisperContext::new_with_params(model_path, ctx_params)
        .map_err(|e| format!("Failed to load whisper model: {}", e))?;

    WHISPER_CTX
        .set(ctx)
        .map_err(|_| "Model already initialized".to_string())?;
    Ok(())
}

pub fn transcribe(audio_data: &[f32]) -> Result<String, String> {
    let ctx = WHISPER_CTX
        .get()
        .ok_or("Whisper model not initialized")?;

    if audio_data.len() <= CHUNK_SIZE {
        return transcribe_single(ctx, audio_data);
    }

    // Chunk long audio
    let mut texts = Vec::new();
    let chunks = compute_chunks(audio_data.len(), CHUNK_SIZE, CHUNK_OVERLAP);
    for (start, end) in &chunks {
        let chunk = &audio_data[*start..*end];
        let text = transcribe_single(ctx, chunk)?;
        texts.push(text);
    }

    let combined = texts.join(" ");
    Ok(detect_and_remove_repetitions(&combined)
        .trim()
        .to_string())
}

fn transcribe_single(ctx: &WhisperContext, audio_data: &[f32]) -> Result<String, String> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_nst(true);
    params.set_no_context(true);
    params.set_entropy_thold(2.0);
    params.set_logprob_thold(-0.5);
    params.set_temperature_inc(0.4);
    params.set_max_tokens(256);

    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Failed to create state: {}", e))?;

    state
        .full(params, audio_data)
        .map_err(|e| format!("Whisper inference failed: {}", e))?;

    let num_segments = state.full_n_segments();
    let mut text = String::new();

    for i in 0..num_segments {
        if let Some(segment) = state.get_segment(i) {
            if segment.no_speech_probability() > 0.8 {
                continue;
            }
            if let Ok(s) = segment.to_str() {
                text.push_str(s);
            }
        }
    }

    Ok(detect_and_remove_repetitions(&text).trim().to_string())
}

fn compute_chunks(total_len: usize, chunk_size: usize, overlap: usize) -> Vec<(usize, usize)> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < total_len {
        let end = (start + chunk_size).min(total_len);
        chunks.push((start, end));
        if end == total_len {
            break;
        }
        start = end.saturating_sub(overlap);
    }
    chunks
}

pub fn detect_and_remove_repetitions(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }

    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() < 4 {
        return text.to_string();
    }

    let max_ngram = (words.len() / 3).min(50);
    for ngram_size in (1..=max_ngram).rev() {
        let max_repeats = if ngram_size <= 2 { 4 } else { 2 };
        if words.len() < ngram_size * (max_repeats + 1) {
            continue;
        }

        let mut i = 0;
        while i + ngram_size <= words.len() {
            let ngram = &words[i..i + ngram_size];
            let mut repeat_count = 1;
            let mut j = i + ngram_size;
            while j + ngram_size <= words.len() {
                if &words[j..j + ngram_size] == ngram {
                    repeat_count += 1;
                    j += ngram_size;
                } else {
                    break;
                }
            }
            if repeat_count > max_repeats {
                let before = &words[..i + ngram_size];
                let after = &words[j..];
                let mut result_words: Vec<&str> = before.to_vec();
                result_words.extend_from_slice(after);
                return detect_and_remove_repetitions(&result_words.join(" "));
            }
            i += 1;
        }
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_repetition_clean_text_unchanged() {
        let input = "Hello world this is normal text";
        assert_eq!(detect_and_remove_repetitions(input), input);
    }

    #[test]
    fn test_repetition_phrase_loop_truncated() {
        let input = "Real content. I said this. I said this. I said this. I said this.";
        let result = detect_and_remove_repetitions(input);
        assert!(result.contains("Real content."));
        let count = result.matches("I said this.").count();
        assert!(count <= 2);
    }

    #[test]
    fn test_repetition_empty_input() {
        assert_eq!(detect_and_remove_repetitions(""), "");
    }

    #[test]
    fn test_compute_chunks_short() {
        let chunks = compute_chunks(1000, CHUNK_SIZE, CHUNK_OVERLAP);
        assert_eq!(chunks, vec![(0, 1000)]);
    }

    #[test]
    fn test_compute_chunks_multiple() {
        let total = 6_000_000;
        let chunks = compute_chunks(total, CHUNK_SIZE, CHUNK_OVERLAP);
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0].0, 0);
        assert_eq!(chunks.last().unwrap().1, total);
    }
}
