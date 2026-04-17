import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the workspace as the first screen", () => {
    render(<App />);

    expect(screen.getByText("Drop images here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Resize" })).toBeDisabled();
    expect(screen.getByText("Your local queue is empty")).toBeInTheDocument();
  });
});
