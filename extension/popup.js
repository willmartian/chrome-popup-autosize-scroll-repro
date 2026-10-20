// A bare-bones virtual list: only the rows in view (plus a buffer) exist, re-rendered on scroll.
const ROWS = 2000;
const ROW_HEIGHT = 60;
const BUFFER = 5;
const scroller = document.getElementById("scroller");
const spacer = document.getElementById("spacer");
spacer.style.height = `${ROWS * ROW_HEIGHT}px`;

function render() {
  const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - BUFFER);
  const last = Math.min(ROWS, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_HEIGHT) + BUFFER);
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.top = `${i * ROW_HEIGHT}px`;
    row.textContent = `Row ${i + 1}`;
    frag.appendChild(row);
  }
  spacer.replaceChildren(frag);
}

scroller.addEventListener("scroll", render, { passive: true });
render();

// Page weight that every viewport-size change re-lays out: 3,000 paragraphs under the
// viewport-sized root, clipped out of view.
const HEAVY = 3000;
const box = document.createElement("div");
box.style.cssText = "height:0;overflow:hidden";
const text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ".repeat(3);
for (let i = 0; i < HEAVY; i++) {
  const p = document.createElement("p");
  p.textContent = text;
  box.appendChild(p);
}
document.getElementById("root").appendChild(box);
