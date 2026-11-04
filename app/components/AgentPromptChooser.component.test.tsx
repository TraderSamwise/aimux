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
    render(
      <AgentPromptChooser
        selection={PERMISSION}
        busyLabel={null}
        refusal={null}
        onChoose={onChoose}
        onGiveUpWaiting={vi.fn()}
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
      subject: undefined,
    });
  });

  it("offers the unnumbered shape too, without inventing numbers for it", () => {
    const onChoose = vi.fn();
    render(
      <AgentPromptChooser
        selection={TRUST}
        busyLabel={null}
        refusal={null}
        onChoose={onChoose}
        onGiveUpWaiting={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Yes, I trust this folder" }));

    expect(onChoose).toHaveBeenCalledWith({
      label: "Yes, I trust this folder",
      number: undefined,
      question: "Quick safety check: Is this a project you created or one you trust?",
      subject: undefined,
    });
  });

  it("renders the options in the order the service gave them", () => {
    render(
      <AgentPromptChooser
        selection={PERMISSION}
        busyLabel={null}
        refusal={null}
        onChoose={vi.fn()}
        onGiveUpWaiting={vi.fn()}
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
        onGiveUpWaiting={vi.fn()}
      />,
    );

    // Not the composer's shared error line: that slot is cleared by the next
    // keystroke, so the one message explaining why the buttons did not work
    // disappeared the moment the user reached for the composer.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/no longer offers/)).toBeTruthy();
  });

  it("offers a way out of an answer the pane never confirmed", () => {
    const onGiveUpWaiting = vi.fn();
    render(
      <AgentPromptChooser
        selection={PERMISSION}
        busyLabel="Yes"
        refusal={null}
        onChoose={vi.fn()}
        onGiveUpWaiting={onGiveUpWaiting}
      />,
    );

    // The hold ends when the pane says the chooser moved on, and a pane that
    // stops answering — the agent exited, the stream dropped — would otherwise
    // hold it forever with every row disabled. On the trust prompt that is
    // worse than a dead end: the composer is the only way left to the pane,
    // and its carriage return commits the cursor row, which is "No, exit".
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting for this answer" }));

    expect(onGiveUpWaiting).toHaveBeenCalledTimes(1);
  });

  it("takes no second answer while the first is still going", () => {
    const onChoose = vi.fn();
    render(
      <AgentPromptChooser
        selection={PERMISSION}
        busyLabel="No"
        refusal={null}
        onChoose={onChoose}
        onGiveUpWaiting={vi.fn()}
      />,
    );

    expect(screen.getByText("sending…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    // Two answers in flight would move the cursor twice and commit once,
    // against whichever option the second walk happened to reach.
    expect(onChoose).not.toHaveBeenCalled();
  });
});
