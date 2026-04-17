use wasm_bindgen::prelude::*;

const CHANNELS: usize = 4;

#[wasm_bindgen]
pub fn resize_rgba(
    input: &[u8],
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> Result<Vec<u8>, JsValue> {
    resize_rgba_inner(
        input,
        source_width as usize,
        source_height as usize,
        target_width as usize,
        target_height as usize,
    )
    .map_err(JsValue::from_str)
}

#[wasm_bindgen]
pub fn crop_rgba(
    input: &[u8],
    source_width: u32,
    source_height: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, JsValue> {
    crop_rgba_inner(
        input,
        source_width as usize,
        source_height as usize,
        x as usize,
        y as usize,
        width as usize,
        height as usize,
    )
    .map_err(JsValue::from_str)
}

#[wasm_bindgen]
pub fn premultiply_alpha(input: &[u8]) -> Result<Vec<u8>, JsValue> {
    validate_rgba_buffer(input, input.len() / CHANNELS, 1)
        .map_err(|error| JsValue::from_str(&error))?;

    let mut output = input.to_vec();
    for pixel in output.chunks_exact_mut(CHANNELS) {
        let alpha = pixel[3] as u16;
        pixel[0] = ((pixel[0] as u16 * alpha + 127) / 255) as u8;
        pixel[1] = ((pixel[1] as u16 * alpha + 127) / 255) as u8;
        pixel[2] = ((pixel[2] as u16 * alpha + 127) / 255) as u8;
    }

    Ok(output)
}

#[wasm_bindgen]
pub fn unpremultiply_alpha(input: &[u8]) -> Result<Vec<u8>, JsValue> {
    validate_rgba_buffer(input, input.len() / CHANNELS, 1)
        .map_err(|error| JsValue::from_str(&error))?;

    let mut output = input.to_vec();
    for pixel in output.chunks_exact_mut(CHANNELS) {
        let alpha = pixel[3] as u16;
        if alpha == 0 {
            pixel[0] = 0;
            pixel[1] = 0;
            pixel[2] = 0;
            continue;
        }

        pixel[0] = ((pixel[0] as u16 * 255 + alpha / 2) / alpha).min(255) as u8;
        pixel[1] = ((pixel[1] as u16 * 255 + alpha / 2) / alpha).min(255) as u8;
        pixel[2] = ((pixel[2] as u16 * 255 + alpha / 2) / alpha).min(255) as u8;
    }

    Ok(output)
}

fn resize_rgba_inner(
    input: &[u8],
    source_width: usize,
    source_height: usize,
    target_width: usize,
    target_height: usize,
) -> Result<Vec<u8>, String> {
    validate_dimensions(source_width, source_height)?;
    validate_dimensions(target_width, target_height)?;
    validate_rgba_buffer(input, source_width, source_height)?;

    let mut output = vec![0; target_width * target_height * CHANNELS];
    let x_ratio = source_width as f32 / target_width as f32;
    let y_ratio = source_height as f32 / target_height as f32;

    for target_y in 0..target_height {
        let source_y = ((target_y as f32 + 0.5) * y_ratio - 0.5).max(0.0);
        let y0 = source_y.floor() as usize;
        let y1 = (y0 + 1).min(source_height - 1);
        let y_lerp = source_y - y0 as f32;

        for target_x in 0..target_width {
            let source_x = ((target_x as f32 + 0.5) * x_ratio - 0.5).max(0.0);
            let x0 = source_x.floor() as usize;
            let x1 = (x0 + 1).min(source_width - 1);
            let x_lerp = source_x - x0 as f32;

            let output_index = (target_y * target_width + target_x) * CHANNELS;
            for channel in 0..CHANNELS {
                let top_left = input[(y0 * source_width + x0) * CHANNELS + channel] as f32;
                let top_right = input[(y0 * source_width + x1) * CHANNELS + channel] as f32;
                let bottom_left = input[(y1 * source_width + x0) * CHANNELS + channel] as f32;
                let bottom_right = input[(y1 * source_width + x1) * CHANNELS + channel] as f32;

                let top = top_left + (top_right - top_left) * x_lerp;
                let bottom = bottom_left + (bottom_right - bottom_left) * x_lerp;
                output[output_index + channel] = (top + (bottom - top) * y_lerp).round() as u8;
            }
        }
    }

    Ok(output)
}

fn crop_rgba_inner(
    input: &[u8],
    source_width: usize,
    source_height: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> Result<Vec<u8>, String> {
    validate_dimensions(source_width, source_height)?;
    validate_dimensions(width, height)?;
    validate_rgba_buffer(input, source_width, source_height)?;

    if x >= source_width || y >= source_height {
        return Err("Crop origin is outside the source image.".to_string());
    }

    if x + width > source_width || y + height > source_height {
        return Err("Crop rectangle exceeds the source image.".to_string());
    }

    let mut output = vec![0; width * height * CHANNELS];
    for row in 0..height {
        let source_start = ((y + row) * source_width + x) * CHANNELS;
        let source_end = source_start + width * CHANNELS;
        let target_start = row * width * CHANNELS;
        output[target_start..target_start + width * CHANNELS]
            .copy_from_slice(&input[source_start..source_end]);
    }

    Ok(output)
}

fn validate_dimensions(width: usize, height: usize) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("Image dimensions must be greater than zero.".to_string());
    }
    Ok(())
}

fn validate_rgba_buffer(input: &[u8], width: usize, height: usize) -> Result<(), String> {
    let expected_len = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(CHANNELS))
        .ok_or_else(|| "Image dimensions are too large.".to_string())?;

    if input.len() != expected_len {
        return Err(format!(
            "Invalid RGBA buffer length: expected {expected_len}, got {}.",
            input.len()
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_returns_expected_region() {
        let input = vec![
            1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255,
        ];

        let cropped = crop_rgba_inner(&input, 2, 2, 1, 0, 1, 2).unwrap();

        assert_eq!(cropped, vec![2, 0, 0, 255, 4, 0, 0, 255]);
    }

    #[test]
    fn crop_rejects_out_of_bounds_rectangles() {
        let input = vec![0; 4 * 4 * CHANNELS];

        let error = crop_rgba_inner(&input, 4, 4, 3, 3, 2, 2).unwrap_err();

        assert!(error.contains("exceeds"));
    }

    #[test]
    fn resize_returns_target_dimensions() {
        let input = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];

        let resized = resize_rgba_inner(&input, 2, 2, 4, 4).unwrap();

        assert_eq!(resized.len(), 4 * 4 * CHANNELS);
    }

    #[test]
    fn invalid_buffer_length_is_rejected() {
        let error = resize_rgba_inner(&[0, 1, 2], 1, 1, 2, 2).unwrap_err();

        assert!(error.contains("Invalid RGBA buffer length"));
    }
}
