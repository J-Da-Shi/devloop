const header = document.querySelector("[data-header]");
const progress = document.querySelector(".scroll-progress");

const updateScrollState = () => {
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const ratio = scrollable > 0 ? Math.min(window.scrollY / scrollable, 1) : 0;
  if (progress) progress.style.width = `${ratio * 100}%`;
  header?.classList.toggle("is-scrolled", window.scrollY > 10);
};
window.addEventListener("scroll", updateScrollState, { passive: true });
updateScrollState();

const tabs = [...document.querySelectorAll(".showcase-tab")];
const image = document.querySelector("[data-showcase-image]");
const title = document.querySelector("[data-showcase-title]");
const copy = document.querySelector("[data-showcase-copy]");
const index = document.querySelector("[data-showcase-index]");
const openButtons = [...document.querySelectorAll("[data-open-shot]")];
const dialog = document.querySelector("[data-shot-dialog]");
const dialogImage = document.querySelector("[data-dialog-image]");
const dialogCaption = document.querySelector("[data-dialog-caption]");
const closeButton = document.querySelector("[data-close-shot]");

const tabIndex = ["DIFF", "VERIFY", "RUN"];
let currentShot = "shots/review-diff.png";
let currentCaption = "DevLoop 审核工作区";

const selectTab = (tab, tabPosition) => {
  tabs.forEach((item) => {
    const active = item === tab;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
  });
  currentShot = tab.dataset.shot || currentShot;
  currentCaption = tab.dataset.title || "DevLoop 产品截图";
  if (image) {
    image.src = currentShot;
    image.alt = currentCaption;
  }
  if (title) title.textContent = tab.dataset.title || "";
  if (copy) copy.textContent = tab.dataset.copy || "";
  if (index) index.textContent = tabIndex[tabPosition] || "VIEW";
};

tabs.forEach((tab, position) => tab.addEventListener("click", () => selectTab(tab, position)));

const openShot = () => {
  if (!dialog || !dialogImage) return;
  dialogImage.src = currentShot;
  dialogImage.alt = currentCaption;
  if (dialogCaption) dialogCaption.textContent = currentCaption;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    document.body.classList.add("is-dialog-open");
  }
};
const closeShot = () => {
  if (!dialog) return;
  dialog.close();
  document.body.classList.remove("is-dialog-open");
};
openButtons.forEach((button) => button.addEventListener("click", openShot));
closeButton?.addEventListener("click", closeShot);
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) closeShot();
});
dialog?.addEventListener("close", () => document.body.classList.remove("is-dialog-open"));
