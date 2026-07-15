# Template Variables

All templates support these variables. The Agent fills them from user input or vision analysis.

| Variable | Source | Description |
|----------|--------|-------------|
| `{{system}}` | `system.md` | Global style/palette/constraints |
| `{{style}}` | User input or brand discovery | Visual style (pixel art, flat vector, semi-realistic) |
| `{{palette}}` | Vision analysis of reference image | HEX color palette, comma-separated |
| `{{description}}` | User input | Free-text character description |
| `{{reference_notes}}` | Vision model analysis | Detailed character features extracted from reference image |
| `{{base_image}}` | Generated base-pet | Reference to attach for subsequent animations |

## Vision Analysis Output Schema

When a vision-capable model analyzes a reference image, it produces:

```json
{
  "character_type": "cat | robot | dragon | humanoid | creature | custom",
  "head_shape": "round, pointed ears, long fur",
  "color_palette": ["#FF6B4F", "#FFF8E7", "#364152"],
  "key_features": ["fluffy tail", "green eyes", "triangle ears"],
  "material_style": "flat vector | pixel art | semi-realistic | cel-shaded",
  "pose_hints": "front-facing, slight head tilt",
  "avoid": ["photorealism", "3D rendering", "complex backgrounds"]
}
```

This JSON is used to populate template variables by the Agent.
