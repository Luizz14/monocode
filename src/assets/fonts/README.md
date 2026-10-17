# Bundled fonts

The composer's model slider sets the model name in JetBrains Mono and the
effort level in Playfair Display, as in the design. Only the two faces it uses
are bundled, so the slider looks the same without either family installed.

| File | Family | Style | Unicode range |
| --- | --- | --- | --- |
| `JetBrainsMono-Medium-latin.woff2` | JetBrains Mono | 500, normal | Latin |
| `JetBrainsMono-Medium-latin-ext.woff2` | JetBrains Mono | 500, normal | Latin Extended |
| `PlayfairDisplay-Italic-latin.woff2` | Playfair Display | 400, italic | Latin |
| `PlayfairDisplay-Italic-latin-ext.woff2` | Playfair Display | 400, italic | Latin Extended |

The files are unmodified copies of what Google Fonts serves for those faces
(`fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500&family=Playfair+Display:ital,wght@1,400`;
JetBrains Mono v24, Playfair Display v40), downloaded on 2026-10-17. The
unicode ranges in `ModelPresetSlider.css` match the ones Google Fonts declares
for each file.

Both families are licensed under the SIL Open Font License 1.1:

- JetBrains Mono: `JetBrainsMono-OFL.txt`, from
  https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt
  (upstream: https://github.com/JetBrains/JetBrainsMono)
- Playfair Display: `PlayfairDisplay-OFL.txt`, from
  https://github.com/google/fonts/blob/main/ofl/playfairdisplay/OFL.txt
  (upstream: https://github.com/clauseggers/Playfair-Display). "Playfair
  Display" is a Reserved Font Name; the files here are redistributed as
  served, without changes.
