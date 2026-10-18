import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ComposerControl } from "@/components/ComposerControl";

describe("ComposerControl web rendering", () => {
  it("keeps the accessible action when a narrow control hides its visible label", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <ComposerControl
        icon={null}
        label="Attach"
        accessibilityLabel="Attach a file"
        wide={false}
        onPress={onPress}
      />,
    );
    const button = screen.getByRole("button", { name: "Attach a file" });
    expect(screen.queryByText("Attach")).toBeNull();
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);

    rerender(
      <ComposerControl
        icon={null}
        label="Attach"
        accessibilityLabel="Attach a file"
        wide
        onPress={onPress}
        disabled
      />,
    );
    expect(screen.getByText("Attach")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Attach a file" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
