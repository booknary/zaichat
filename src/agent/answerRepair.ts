export interface AnswerDraft {
  answer: string;
  sourceIDs: string[];
  evidenceInsufficient: boolean;
  evidenceFacts?: unknown[];
}

/** Patches only the run-local draft; every repaired answer is validated again. */
export function repairAnswerDraft(
  previous: AnswerDraft | undefined,
  input: Record<string, any>,
): AnswerDraft {
  if (!previous) throw new Error("No rejected answer draft exists in this run");
  if (input.answer !== undefined)
    throw new Error("Submit either a full answer or repair, not both");
  if (
    input.repair !== undefined &&
    (!input.repair ||
      typeof input.repair !== "object" ||
      Array.isArray(input.repair) ||
      Object.keys(input.repair).some((key) => key !== "answerPatches"))
  )
    throw new Error("Invalid answer repair object");
  const patches = input.repair?.answerPatches ?? [];
  if (!Array.isArray(patches) || patches.length > 8)
    throw new Error("At most eight answer patches are allowed");
  if (
    !patches.length &&
    !Array.isArray(input.evidenceFacts) &&
    !Array.isArray(input.sourceIDs)
  )
    throw new Error("Repair needs answerPatches or corrected evidenceFacts");
  let answer = previous.answer;
  for (const patch of patches) {
    if (
      !patch ||
      typeof patch.original !== "string" ||
      typeof patch.replacement !== "string" ||
      patch.original.length > 2400 ||
      patch.replacement.length > 2400 ||
      Object.keys(patch).some((key) => !["original", "replacement"].includes(key))
    )
      throw new Error("Answer patches need bounded original/replacement strings only");
    const original = patch.original;
    const at = answer.indexOf(original);
    if (!original || at < 0 || answer.indexOf(original, at + 1) >= 0)
      throw new Error("Answer patch must match exactly one existing draft span");
    answer =
      answer.slice(0, at) + patch.replacement + answer.slice(at + original.length);
  }
  return {
    ...previous,
    answer,
    sourceIDs: input.sourceIDs,
    evidenceInsufficient: input.evidenceInsufficient,
    evidenceFacts: input.evidenceFacts ?? previous.evidenceFacts,
  };
}
