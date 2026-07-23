import { createApp } from "vue";

import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./index.css";
import "./theme.css";

import App from "./App.vue";
import { initTheme } from "./theme.ts";

initTheme();

createApp(App).mount("#root");
