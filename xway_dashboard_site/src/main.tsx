import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./app/router";
import "./index.css";
import "../css/base.css";
import "../css/campaigns.css";
import "../css/detail.css";
import "../css/catalog-issues.css";
import "../css/catalog-table.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
