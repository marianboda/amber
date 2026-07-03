// Injected into ALL frames before capture. Importing the frames bundle
// registers a message listener; the top-frame capture then collects each
// frame's content over postMessage and inlines it into the snapshot.
import "single-file-core/single-file-frames.js";

export default defineUnlistedScript(() => {});
