import { ConversationFileStore } from "../core/conversationRepository";

export class ZoteroFileStore implements ConversationFileStore {
  async read(path: string): Promise<string> {
    return Zotero.File.getContentsAsync(path) as Promise<string>;
  }
  async write(path: string, content: string): Promise<void> {
    await Zotero.File.putContentsAsync(path, content);
  }
  async exists(path: string): Promise<boolean> {
    return IOUtils.exists(path);
  }
  async move(source: string, destination: string): Promise<void> {
    await IOUtils.move(source, destination, { noOverwrite: false });
  }
  async remove(path: string): Promise<void> {
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
  async mkdir(path: string): Promise<void> {
    await IOUtils.makeDirectory(path, { ignoreExisting: true });
  }
  join(...parts: string[]): string {
    return PathUtils.join(...parts);
  }
}
