declare module "single-file-core/single-file.js" {
  export function init(initOptions: unknown): void;
  export function getPageData(
    options?: Record<string, unknown>,
    initOptions?: unknown,
    doc?: Document,
    win?: Window
  ): Promise<{ content: string; title?: string }>;
}
