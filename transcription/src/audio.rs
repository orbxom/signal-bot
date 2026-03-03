use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub fn decode_audio_file(path: &str) -> Result<Vec<f32>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let hint = Hint::new();
    // Don't set hint extension — let symphonia auto-detect (signal-cli files have no extension)

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Failed to probe audio format: {}", e))?;

    let mut format = probed.format;
    let track = format.default_track().ok_or("No audio track found")?;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or("Unknown sample rate")?;
    let channels = track
        .codec_params
        .channels
        .ok_or("Unknown channel layout")?
        .count();
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    let mut samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(e) => return Err(format!("Error reading packet: {}", e)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder
            .decode(&packet)
            .map_err(|e| format!("Decode error: {}", e))?;

        let spec = *decoded.spec();
        let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);

        samples.extend_from_slice(sample_buf.samples());
    }

    // Downmix to mono
    let mono = if channels > 1 {
        downmix_to_mono(&samples, channels)
    } else {
        samples
    };

    // Resample to 16kHz if needed
    if sample_rate != 16000 {
        resample_to_16khz(&mono, sample_rate)
    } else {
        Ok(mono)
    }
}

fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn resample_to_16khz(samples: &[f32], source_rate: u32) -> Result<Vec<f32>, String> {
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    };

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let ratio = 16000.0 / source_rate as f64;
    let mut resampler = SincFixedIn::<f64>::new(ratio, 2.0, params, 1024, 1)
        .map_err(|e| format!("Failed to create resampler: {}", e))?;

    let samples_f64: Vec<f64> = samples.iter().map(|&s| s as f64).collect();
    let mut output = Vec::new();

    for chunk in samples_f64.chunks(1024) {
        if chunk.len() == 1024 {
            let input = vec![chunk.to_vec()];
            let result = resampler
                .process(&input, None)
                .map_err(|e| format!("Resampling error: {}", e))?;
            output.extend(result[0].iter().map(|&s| s as f32));
        } else {
            // Last partial chunk — use process_partial
            let input = vec![chunk.to_vec()];
            let result = resampler
                .process_partial(Some(&input), None)
                .map_err(|e| format!("Resampling error on final chunk: {}", e))?;
            output.extend(result[0].iter().map(|&s| s as f32));
        }
    }

    // Flush remaining samples from the resampler's internal FIR filter
    let flush = resampler
        .process_partial::<Vec<f64>>(None, None)
        .map_err(|e| format!("Resampling flush error: {}", e))?;
    output.extend(flush[0].iter().map(|&s| s as f32));

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_downmix_stereo_to_mono() {
        let stereo = vec![1.0, 0.0, 0.5, 0.5, 0.0, 1.0];
        let mono = downmix_to_mono(&stereo, 2);
        assert_eq!(mono.len(), 3);
        assert!((mono[0] - 0.5).abs() < 1e-6);
        assert!((mono[1] - 0.5).abs() < 1e-6);
        assert!((mono[2] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_downmix_mono_passthrough() {
        let mono_input = vec![0.1, 0.2, 0.3];
        let result = downmix_to_mono(&mono_input, 1);
        assert_eq!(result, mono_input);
    }

    #[test]
    fn test_resample_halves_sample_count() {
        // 32kHz to 16kHz should roughly halve the sample count
        let samples: Vec<f32> = (0..32000).map(|i| (i as f32 * 0.001).sin()).collect();
        let result = resample_to_16khz(&samples, 32000).unwrap();
        let ratio = result.len() as f64 / 16000.0;
        assert!(
            ratio > 0.9 && ratio < 1.1,
            "Expected ~16000 samples, got {}",
            result.len()
        );
    }
}
