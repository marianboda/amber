// Unlisted script injected on demand by the background worker. Bundles
// single-file-core and exposes one global that returns the current page as a
// single self-contained HTML string (assets inlined as data: URIs). Runs in
// the page's context, so it sees the authenticated, fully-rendered DOM.
import { getPageData } from "single-file-core/single-file.js";

export default defineUnlistedScript(() => {
  (globalThis as any).__amberCapture = async (): Promise<string> => {
    const pageData = await getPageData(
      {
        removeHiddenElements: true,
        removeUnusedStyles: true,
        removeUnusedFonts: true,
        compressHTML: true,
        loadDeferredImages: true,
        loadDeferredImagesMaxIdleTime: 1500,
        blockScripts: true,
        removeAlternativeFonts: true,
        removeAlternativeMedias: true,
        removeAlternativeImages: true,
        groupDuplicateImages: true,
      },
      { fetch: (url: string, options?: RequestInit) => fetch(url, options) }
    );
    return pageData.content;
  };
});
