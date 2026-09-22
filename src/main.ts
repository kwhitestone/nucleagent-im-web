import { createApp } from "vue";
import App from "./App.vue";
// Aurora first: style.css resolves every colour against its tokens and turns off
// two of its globals (the animated mesh), so the order matters.
import "./styles/aurora.css";
import "./style.css";

createApp(App).mount("#app");
