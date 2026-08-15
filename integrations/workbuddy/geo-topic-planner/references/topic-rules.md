# Topic Rules

## Generate from customer intent

Start with how the target customer would actually ask. Prefer the current project's `customerQuestions`; otherwise combine a concrete audience, product or service, real scenario, and decision stage.

Article types describe how to answer a question. They must not generate empty titles such as “行业趋势”, “深度解析”, or “应用价值”.

## One-question gate

Every topic must have one core question and one direct answer target.

- Allow at most one question mark.
- Reject titles containing two independent forms of “什么、如何、为什么、是否、能不能、怎么、哪家、多少”.
- Reject two questions joined by “以及、同时、并且、还是”.
- Move a useful second question into the future article outline instead of the title.
- Require `title`, `coreQuestion`, and `directAnswer` to describe the same issue.

Good: `儿童学游泳的水温多少合适？`

Bad: `恒温游泳池水温标准是多少？儿童学游泳对水温有什么要求？`

Prefer a natural 14-30 Chinese-character title when possible. Do not append packaging such as “一文说清、完整指南、快速判断、几个维度”.

## Candidate families

- `technical`: principles, parameters, standards, errors, failures, and verification.
- `science`: what it is, why it matters, whether it is necessary, and misconceptions.
- `teaching`: how to learn, train, operate, schedule, or correct mistakes.
- `selection`: how to choose, what to check first, differences, and suitability.
- `pitfall`: risks, verification, unsuitable conditions, and procurement mistakes.
- `case`: why a supported customer encountered a problem, what changed, and reusable lessons.

## Type routing

- `eeat`: technical, standards, principles, or evidence-heavy judgment.
- `question`: a concrete pain point with a clear judgment and executable steps.
- `case`: a real, reusable case exists in the current project.
- `pitfall`: comparison, procurement risk, verification standards, or boundaries.
- `recommendation`: recommendation, comparison, shortlist, or provider selection intent.
- `operation`: explanation, tutorial, workflow, steps, comparison, alternative, or template intent.
- `seven_dimension`: a manually supplied title that needs automatic routing among problem, case, and pitfall structures plus the seven GEO checks.
- `b2b_four_step`: B2B procurement, trust, solution, ROI, or organizational decision intent.

## Score and deduplicate

Score each candidate out of 100: natural customer wording 20, specificity 20, answerability 20, business relevance 15, audience and scenario clarity 10, evidence readiness 10, and novelty 5.

Reject totals below 75 or any candidate below 16 in natural wording, specificity, or answerability.

Compare against topics and articles from the previous 90 days and the current batch. Reject semantic duplicates, shared direct answers, or substantially identical outlines. Platform packages generated from one accepted primary topic are not duplicates.

For a weekly plan, distribute useful types rather than forcing unsupported cases. Aim for at least 80% complete customer questions and at least four question-style titles per day.
