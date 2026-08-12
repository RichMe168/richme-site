(() => {
  const button = document.querySelector("[data-menu-toggle]");
  const nav = document.querySelector("[data-site-nav]");
  if (!button || !nav) return;

  const closeMenu = () => {
    nav.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "開啟導覽選單");
    document.body.classList.remove("menu-open");
  };

  button.addEventListener("click", () => {
    const willOpen = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", willOpen);
    button.setAttribute("aria-expanded", String(willOpen));
    button.setAttribute("aria-label", willOpen ? "關閉導覽選單" : "開啟導覽選單");
    document.body.classList.toggle("menu-open", willOpen);
  });

  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) closeMenu();
  });
})();
