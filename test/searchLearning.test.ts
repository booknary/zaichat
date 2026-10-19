import { describe, expect, it } from "vitest";
import { SearchLearningRepository } from "../src/core/searchLearningRepository";
import type { ConversationFileStore } from "../src/core/conversationRepository";

class MemoryStore implements ConversationFileStore {
  files = new Map<string, string>();
  async read(path: string) {
    return this.files.get(path) || "";
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async move(source: string, destination: string) {
    this.files.set(destination, this.files.get(source) || "");
    this.files.delete(source);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async mkdir() {}
  join(...parts: string[]) {
    return parts.join("/");
  }
}

describe("search learning", () => {
  it("persists only explicit positive feedback and reuses it for similar queries", async () => {
    const store = new MemoryStore();
    const learning = new SearchLearningRepository(store, "search-learning.json");
    await learning.initialize();
    await learning.recordRelevant(
      "帮我找两次基因组创新的陆生植物文章",
      "The origin of land plants is rooted in two bursts of genomic novelty",
    );
    const restored = new SearchLearningRepository(store, "search-learning.json");
    await restored.initialize();
    const suggestions = restored.suggestionsFor("两次基因组创新的文章");
    expect(suggestions.titles).toContain(
      "The origin of land plants is rooted in two bursts of genomic novelty",
    );
    expect(suggestions.terms).toContain("genomic");
    await restored.recordIrrelevant(
      "两次基因组创新的文章",
      "Genome sequencing methods unrelated to innovation",
    );
    expect(restored.suggestionsFor("两次基因组创新的文章").rejectedTitles).toContain(
      "Genome sequencing methods unrelated to innovation",
    );
    expect(store.files.get("search-learning.json")).not.toContain("fulltext");
  });
});
