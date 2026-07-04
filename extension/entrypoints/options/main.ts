const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load() {
  const stored = (await browser.storage.local.get(["serverUrl", "token", "device"])) as {
    serverUrl?: string;
    token?: string;
    device?: string;
  };
  $("serverUrl").value = stored.serverUrl ?? "";
  $("token").value = stored.token ?? "";
  $("device").value = stored.device ?? "";
}

async function save() {
  const status = document.getElementById("status")!;
  const serverUrl = $("serverUrl").value.trim().replace(/\/$/, "");
  const token = $("token").value.trim();
  const device = $("device").value.trim();
  await browser.storage.local.set({ serverUrl, token, device });
  status.textContent = "testing…";
  try {
    const res = await fetch(`${serverUrl}/api/ping`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    status.textContent = res.ok ? "✓ connected" : `✗ ${res.status === 401 ? "bad token" : `HTTP ${res.status}`}`;
  } catch {
    status.textContent = "✗ cannot reach server";
  }
}

document.getElementById("save")!.addEventListener("click", save);
load();
