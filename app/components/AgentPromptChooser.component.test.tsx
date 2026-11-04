import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AgentPromptChooser,
  paneIsWaitingOnAnUnreadablePrompt,
} from "@/components/AgentPromptChooser";
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

describe("paneIsWaitingOnAnUnreadablePrompt", () => {
  const IDLE = {
    promptVisible: true,
    errorVisible: false,
    interruptedVisible: false,
    updatePromptVisible: false,
  };

  it("tells a pane with no chooser apart from a pane whose chooser cannot be read", () => {
    // An absent selection is three facts, and the rest of paneState separates
    // them. A composer sitting idle means the agent wants words.
    expect(paneIsWaitingOnAnUnreadablePrompt({ ...IDLE })).toBe(false);
    // No chooser AND no idle composer, not erroring, not interrupted: the pane
    // is waiting on something that is not a text field. Showing a live
    // composer in front of that says the agent wants words when it wants a
    // choice — and the trust prompt's default row is "No, exit".
    expect(paneIsWaitingOnAnUnreadablePrompt({ ...IDLE, promptVisible: false })).toBe(true);
    // A readable chooser is not this case.
    expect(
      paneIsWaitingOnAnUnreadablePrompt({
        ...IDLE,
        promptVisible: false,
        selection: TRUST,
      }),
    ).toBe(false);
    // Nor is an error, an interrupt, or an update prompt, each of which has
    // its own treatment.
    expect(
      paneIsWaitingOnAnUnreadablePrompt({ ...IDLE, promptVisible: false, errorVisible: true }),
    ).toBe(false);
    expect(
      paneIsWaitingOnAnUnreadablePrompt({
        ...IDLE,
        promptVisible: false,
        interruptedVisible: true,
      }),
    ).toBe(false);
    expect(
      paneIsWaitingOnAnUnreadablePrompt({
        ...IDLE,
        promptVisible: false,
        updatePromptVisible: true,
      }),
    ).toBe(false);
  });

  it("says nothing about a service that does not project pane state at all", () => {
    expect(paneIsWaitingOnAnUnreadablePrompt(undefined)).toBe(false);
  });
});

describe("AgentPromptChooser", () => {
  it("sends the label the user read, with the number the pane showed", () => {
    const onChoose = vi.fn();
    render(
      <AgentPromptChooser
        selection={PERMISSION}
        busyLabel={null}
        refusal={null}
        onChoose={onChoose}
      />,
    );

    expect(screen.getByText("Do you want to create hello.txt?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No" }));

    // The label is the identity within the question, and the question says
    // which question it was. A press carrying only the row would answer
    // whatever is in row 3 by the time the service looks; a press carrying
    // only the label would answer "No" to whatever is being asked by then.
    expect(onChoose).toHaveBeenCalledWith({
      label: "No",
      number: 3,
      question: "Do you want to create hello.txt?",
    });
  });

  it("offers the unnumbered shape too, without inventing numbers for it", () => {
    const onChoose = vi.fn();
    render(
      <AgentPromptChooser selection={TRUST} busyLabel={null} refusal={null} onChoose={onChoose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Yes, I trust this folder" }));

    expect(onChoose).toHaveBeenCalledWith({
      label: "Yes, I trust this folder",
      number: undefined,
      question: "Quick safety check: Is this a project you created or one you trust?",
    });
  });

  it("renders the options in the order the service gave them", () => {
    render(
      <AgentPromptChooser
        selection={PERMISSION}
        busyLabel={null}
        refusal={null}
        onChoose={vi.fn()}
      />,
    );

    const labels = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));

    // The pane's order IS the chooser's order, because the cursor walks it.
    // A client that sorted these would answer a different row than the one the
    // person pressed.
    expect(labels).toEqual(["Yes", "Yes, and switch to accept edits", "No"]);
  });

  it("keeps the refusal in the card, where the chooser it is about still is", () => {
    render(
      <AgentPromptChooser
        selection={PERMISSION}
        busyLabel={null}
        refusal={'the pane no longer offers "No"; it is showing: Yes / No, allow once'}
        onChoose={vi.fn()}
      />,
    );

    // Not the composer's shared error line: that slot is cleared by the next
    // keystroke, so the one message explaining why the buttons did not work
    // disappeared the moment the user reached for the composer.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/no longer offers/)).toBeTruthy();
  });

  it("takes no second answer while the first is still going", () => {
    const onChoose = vi.fn();
    render(
      <AgentPromptChooser
        selection={PERMISSION}
        busyLabel="No"
        refusal={null}
        onChoose={onChoose}
      />,
    );

    expect(screen.getByText("sending…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    // Two answers in flight would move the cursor twice and commit once,
    // against whichever option the second walk happened to reach.
    expect(onChoose).not.toHaveBeenCalled();
  });
});
