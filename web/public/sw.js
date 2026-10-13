/* Service worker do ValidaURL: só notificações push dos monitores (sem cache offline). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let dados = { titulo: "ValidaURL", corpo: "Algo mudou num monitor.", url: "/" };
  try {
    dados = { ...dados, ...e.data.json() };
  } catch { /* push sem JSON: mensagem padrão */ }
  e.waitUntil(self.registration.showNotification(dados.titulo, {
    body: dados.corpo, icon: "/favicon.svg", badge: "/favicon.svg", data: { url: dados.url }, tag: dados.url,
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const alvo = new URL(e.notification.data?.url ?? "/", self.location.origin).href;
  e.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const j of janelas) {
      if (j.url.startsWith(self.location.origin)) {
        await j.navigate(alvo);
        return j.focus();
      }
    }
    return self.clients.openWindow(alvo);
  })());
});
