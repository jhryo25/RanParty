# System Prompt — Pet Character Constraints

{{#if style}}
Style: {{style}}
{{/if}}
{{#if palette}}
Palette (HEX): {{palette}}
{{/if}}
{{#if reference_notes}}
Reference notes: {{reference_notes}}
{{/if}}

Global constraints:
- Every output is a HORIZONTAL STRIP of frames placed left-to-right with no gaps.
- Single character, no duplicate clones, no multi-character scenes.
- Transparent background on every frame.
- Keep the character fully within each 192x208 cell — no clipped limbs or floating parts.
- Consistent lighting, line weight, and material across all frames and all rows.
- No text, logos, watermarks, UI elements, or readable symbols.
- No speed lines, motion blur, smears, glow effects, shadows, or detached particle effects.
- Chroma-key friendly: avoid colors that bleed into the character edges.
- Sprite production quality: clean silhouettes, readable at pet display size (~100px tall).
