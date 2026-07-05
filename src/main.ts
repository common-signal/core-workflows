import { renderOnboarding } from "./Onboarding";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Common Signal could not find the #app mount point.");
}

renderOnboarding(root);
