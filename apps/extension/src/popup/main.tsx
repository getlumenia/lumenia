/**
 * Popup entry. popup.html is static (no inline script); this bundle renders the shell into #app.
 */
import { render } from "preact";
import { App } from "./App";

const root = document.getElementById("app");
if (root) render(<App />, root);
