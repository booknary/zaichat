import { expect, it } from "vitest";
import { buildProviderMessages } from "../src/agent/agentRunner";
import {
  RETRIEVAL_STRATEGY_VERSION,
  retrievalStrategyPrompt,
} from "../src/agent/retrievalStrategyPrompt";

it("keeps built-in retrieval guidance field-neutral without biological examples", () => {
  const prompt = retrievalStrategyPrompt("");
  expect(prompt).not.toMatch(
    /\b(?:clades?|species|genus|genera|taxon\w*|phylogen\w*|genom\w*|plants?|biology|biological|organisms?)\b/iu,
  );
  expect(prompt).toContain("Do not assume a default discipline");
  expect(prompt).toContain("level of aggregation uncertain");
  expect(prompt).toContain("unit of analysis");
  expect(prompt).toContain("sample/dataset/entity counts");
  expect(prompt).toContain(`v${RETRIEVAL_STRATEGY_VERSION}`);
});

it("retains concept anchors, bounded bilingual routes, verification and permissions", () => {
  const prompt = retrievalStrategyPrompt("");
  for (const rule of [
    "EXPLICIT USER CONCEPTS ARE ANCHORS",
    "one literal translation route",
    "one terminology-synonym route",
    "one proposition-level route",
    "4-8 plausible English title-style reconstructions",
    "only a complete title supplied by the user",
    "Cite only sourceIDs returned in this run",
    "Negative findings must be scoped to checked evidence",
    "Obtain explicit approval before modifying Zotero library data",
  ])
    expect(prompt).toContain(rule);
});

it("does not strip domain terminology from user questions or explicit feedback", () => {
  const question = "Find papers comparing species counts";
  const feedback = "Explicit feedback: preserve the user's plant terminology";
  const messages = buildProviderMessages(
    [
      {
        id: "user",
        role: "user",
        displayText: question,
        createdAt: "2026-10-27T00:00:00Z",
      },
    ],
    {
      refs: { items: [], attachments: [], notes: [], annotations: [], collections: [] },
    },
    "User-customized instructions",
    feedback,
  );
  expect(messages[0].content).toContain("User-customized instructions");
  expect(messages[0].content).toContain(feedback);
  expect(messages[1].content).toContain(question);
});
