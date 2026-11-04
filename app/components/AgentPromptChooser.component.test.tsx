import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentPromptChooser } from "@/components/AgentPromptChooser";
import type { LivePaneSelection } from "@/lib/events";

const PERMISSION: LivePaneSelection = {
  question: "Do you want to create hello.txt?",
  options: [
    { number: 1, label: "Yes", selected: true },
    { number: 2, label: "Yes, and switch to accept edits", selected: false },
    { number: 3, label: "No", selected: false },
  ],
  footer: "Esc to cancel · Tab to amend",
};

const TRUST: LivePaneSelection = {
  question: "Quick safety check: Is this a project you created or one you trust?",
  options: [
    { label: "No, exit", selected: true },
    { label: "Yes, I trust this folder", selected: false },
  ],
};

describe("AgentPromptChooser", () => {
  it("sends the label the user read, with the number the pane showed", () => {
    const onChoose = vi.fn();
    render(<AgentPromptChooser selection={PERMISSION} busyLabel={null} onChoose={onChoose} />);

    expect(screen.getByText("Do you want to create hello.txt?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No" }));

    // The label is the identity. A chooser renumbers from 1 for each question,
    // so a press that carried only the row would answer whatever is in row 3
    // by the time the service looks.
    expect(onChoose).toHaveBeenCalledWith({ label: "No", number: 3 });
  });

  it("offers the unnumbered shape too, without inventing numbers for it", () => {
    const onChoose = vi.fn();
    render(<AgentPromptChooser selection={TRUST} busyLabel={null} onChoose={onChoose} />);

    fireEvent.click(screen.getByRole("button", { name: "Yes, I trust this folder" }));

    expect(onChoose).toHaveBeenCalledWith({ label: "Yes, I trust this folder", number: undefined });
  });

  it("renders the options in the order the service gave them", () => {
    render(<AgentPromptChooser selection={PERMISSION} busyLabel={null} onChoose={vi.fn()} />);

    const labels = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));

    // The pane's order IS the chooser's order, because the cursor walks it.
    // A client that sorted these would answer a different row than the one the
    // person pressed.
    expect(labels).toEqual(["Yes", "Yes, and switch to accept edits", "No"]);
  });

  it("takes no second answer while the first is still going", () => {
    const onChoose = vi.fn();
    render(<AgentPromptChooser selection={PERMISSION} busyLabel="No" onChoose={onChoose} />);

    expect(screen.getByText("sending…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    // Two answers in flight would move the cursor twice and commit once,
    // against whichever option the second walk happened to reach.
    expect(onChoose).not.toHaveBeenCalled();
  });
});
