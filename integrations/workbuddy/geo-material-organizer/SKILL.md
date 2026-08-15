---
name: geo-material-organizer
description: Organize newly uploaded image materials in the current GEO Publisher customer project through one-time visual analysis. Use when the user asks to 整理素材、识别图片、处理待整理图片、建立图片素材库, or before topic/article work when `material pending` returns images. Do not write articles or control publishing platforms.
---

# GEO Material Organizer

Use GEO Publisher Desktop as the only material store. Analyze each imported image once, save a reusable index, and never modify the original file.

## Workflow

1. Resolve the production CLI through the sibling `geo-publisher` Skill.
2. Run `doctor`, `instructions --json`, and `project current`. Stop if no current project exists.
3. Record the exact `project.id`, then run `material pending <projectId> --limit 20`.
4. If no items are returned, report that all images are organized and stop.
5. For each pending item, run `material get <projectId> --material <materialId>`.
6. Open and inspect the exact local image at `item.payload.sourcePath` with the available image-viewing capability. Do not classify from the filename alone.
7. Write one temporary JSON analysis file and submit it with `material analyze <projectId> --material <materialId> --input <analysis.json>`.
8. Delete the temporary JSON file. Re-run `project current` before every write and stop on `PROJECT_CONTEXT_CHANGED`.
9. Continue in batches until `material pending` is empty, then report analyzed count, low-confidence count, and remaining count.

## Analysis Contract

Submit exactly:

```json
{
  "description": "客观描述图片中的主体、环境和可确认细节",
  "category": "product|equipment|factory|process|detail|case|credential|team|logo|scene|other",
  "keywords": ["具体产品", "具体场景"],
  "uses": ["cover", "body", "brand", "proof"],
  "confidence": "high|medium|low",
  "warnings": []
}
```

Use only visible facts. Never invent a customer, location, model number, result, credential owner, or production capacity. Use `low` confidence and explain ambiguity in `warnings` when the image is unclear.

## Selection Rules

- `cover`: clear main subject, usable composition, and no unreadable dense text.
- `body`: supports an article paragraph or explanation.
- `brand`: logo, team, office, or general company identity.
- `proof`: credential, case evidence, process evidence, or verifiable detail.
- A logo is not a general article cover unless the user explicitly requests it.
- A credential image must not be treated as proof for a claim that is not visibly present.
- Do not reanalyze items absent from `material pending`.

## Boundaries

- Do not call generic `content save` to bypass `material analyze` validation.
- Do not move, rename, edit, crop, upload, or delete the original image.
- Do not generate topics or articles; hand those tasks to `geo-topic-planner` or `geo-article-writer` after indexing completes.
- Do not fill or publish platform pages.
