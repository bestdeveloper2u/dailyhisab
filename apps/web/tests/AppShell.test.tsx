import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppShell } from "../src/components/AppShell";
import { Dashboard } from "../src/screens/Dashboard";
import { useLangStore } from "../src/store/lang";

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // localStorage + store may persist between tests — reset to bn defaults.
  window.localStorage.clear();
  useLangStore.setState({ lang: "bn" });
});

describe("AppShell", () => {
  it("renders the brand wordmark and the v0.3.0 version chip", () => {
    renderShell();
    expect(screen.getAllByText("Daily Hisab").length).toBeGreaterThan(0);
    expect(screen.getByText("v0.3.0")).toBeInTheDocument();
  });

  it("switches nav labels from Bengali to English via the compact toggle", async () => {
    const user = userEvent.setup();
    renderShell();
    expect(screen.getAllByText("ড্যাশবোর্ড").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "EN" }));

    expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("ড্যাশবোর্ড")).toHaveLength(0);
  });

  it("shows the Bengali-formatted amount on the dashboard", () => {
    renderShell();
    expect(screen.getAllByText("৳৪,৮২০").length).toBeGreaterThan(0);
  });
});
