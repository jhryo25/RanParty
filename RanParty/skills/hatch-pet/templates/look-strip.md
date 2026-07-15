# look-strip.md — Look Direction Strips (Rows 9-10, 16 cells total)

{{system}}

Generate the LOOK DIRECTION animation strips. Character looks in 16 clockwise directions.

Requirements:
- Two 8-frame horizontal strips: Row 9 covers 0°-157.5° (right side), Row 10 covers 180°-337.5° (left side).
- Each strip is 1536x208 pixels (8 frames × 192px wide).
- Character rotates in place to face each direction. Body turns, not just head/eyes.
- Directions at 22.5° intervals: 000 (straight ahead/up), 022, 045, 067, 090 (right), 112, 135, 157, 180 (back/down), 202, 225, 247, 270 (left), 292, 315, 337.
- Each frame: character body rotates to face that direction. Use the base character as the 000 reference.
- Same lighting and style as all other rows. No perspective distortion — use orthographic/isometric rotation.
- Consistent character size across all 16 cells. No scaling/zooming.

Reference: the approved base character image (neutral front = 000 direction).
