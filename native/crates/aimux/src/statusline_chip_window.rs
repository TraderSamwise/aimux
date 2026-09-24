//! Which footer chips are shown when they do not all fit.
//!
//! The rule is minimal scroll: keep the window where it was, and when the active
//! chip falls outside it, move by the least that brings it back. Tabbing one past
//! the right edge therefore shifts by exactly one chip and leaves the active chip
//! rightmost, tabbing back does the mirror, and jumping straight into an agent
//! from the dashboard is the same rule over a bigger gap -- so nothing at the
//! next/prev/digit/Expose sites has to know that the footer scrolls.
//!
//! Where the window sits is NOT a function of the active chip alone: index 5
//! belongs at the right edge when you arrived from the left and at the left edge
//! when you arrived from the right. The previous offset is what tells those
//! apart, so it is an input here and an output the caller persists.

/// Visible width of `‹` or `›` plus the count beside it.
fn marker_width(hidden: usize, separator_width: i64) -> i64 {
    if hidden == 0 {
        return 0;
    }
    1 + hidden.to_string().chars().count() as i64 + separator_width
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChipWindow {
    pub offset: usize,
    pub count: usize,
    pub hidden_left: usize,
    pub hidden_right: usize,
}

impl ChipWindow {
    pub fn end(&self) -> usize {
        self.offset + self.count
    }
}

/// How many chips fit starting at `offset`, leaving room for whichever markers
/// that window would need. At least one chip is always shown: a single chip
/// wider than the whole status line is still better than an empty footer.
fn window_at(widths: &[i64], offset: usize, max_width: i64, separator_width: i64) -> usize {
    let mut used = marker_width(offset, separator_width);
    let mut count = 0_usize;
    for index in offset..widths.len() {
        let separator = if count == 0 && offset == 0 {
            0
        } else {
            separator_width
        };
        let right_marker = marker_width(widths.len() - index - 1, separator_width);
        if used + separator + widths[index] + right_marker > max_width {
            break;
        }
        used += separator + widths[index];
        count += 1;
    }
    count.max(1)
}

pub fn select_chip_window(
    widths: &[i64],
    active: Option<usize>,
    previous_offset: usize,
    max_width: i64,
    separator_width: i64,
) -> ChipWindow {
    let total = widths.len();
    if total == 0 {
        return ChipWindow {
            offset: 0,
            count: 0,
            hidden_left: 0,
            hidden_right: 0,
        };
    }
    // Everything fits, so there is nothing to scroll and the footer behaves
    // exactly as it did before any of this existed.
    if window_at(widths, 0, max_width, separator_width) >= total {
        return ChipWindow {
            offset: 0,
            count: total,
            hidden_left: 0,
            hidden_right: 0,
        };
    }

    let mut offset = previous_offset.min(total - 1);
    if let Some(active) = active.filter(|index| *index < total) {
        if active < offset {
            offset = active;
        } else {
            // Smallest offset that still shows the active chip, which lands it
            // on the right edge. window_at is at least 1, so this terminates.
            while active >= offset + window_at(widths, offset, max_width, separator_width) {
                offset += 1;
            }
        }
    }
    let count = window_at(widths, offset, max_width, separator_width);
    ChipWindow {
        offset,
        count,
        hidden_left: offset,
        hidden_right: total.saturating_sub(offset + count),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEPARATOR: i64 = 5;

    fn uniform(count: usize, width: i64) -> Vec<i64> {
        vec![width; count]
    }

    #[test]
    fn shows_every_chip_when_they_all_fit() {
        let window = select_chip_window(&uniform(4, 10), Some(3), 0, 200, SEPARATOR);
        assert_eq!(window.offset, 0);
        assert_eq!(window.count, 4);
        assert_eq!((window.hidden_left, window.hidden_right), (0, 0));
    }

    #[test]
    fn a_stored_offset_is_ignored_while_everything_fits() {
        let window = select_chip_window(&uniform(4, 10), Some(0), 3, 200, SEPARATOR);
        assert_eq!(window.offset, 0);
        assert_eq!(window.count, 4);
    }

    #[test]
    fn tabbing_one_past_the_right_edge_shifts_by_exactly_one() {
        let widths = uniform(8, 10);
        let settled = select_chip_window(&widths, Some(2), 0, 60, SEPARATOR);
        assert_eq!(settled.offset, 0);
        let next = select_chip_window(&widths, Some(settled.end()), settled.offset, 60, SEPARATOR);
        assert_eq!(next.offset, settled.offset + 1);
        assert_eq!(next.end(), settled.end() + 1, "active should be rightmost");
    }

    #[test]
    fn tabbing_one_past_the_left_edge_shifts_by_exactly_one() {
        let widths = uniform(8, 10);
        let settled = select_chip_window(&widths, Some(5), 3, 60, SEPARATOR);
        assert_eq!(settled.offset, 3);
        let previous = select_chip_window(&widths, Some(2), settled.offset, 60, SEPARATOR);
        assert_eq!(previous.offset, 2, "active should be leftmost");
    }

    // The property that makes the previous offset an input rather than something
    // derivable: the same active chip sits at opposite edges depending on which
    // side it was reached from.
    #[test]
    fn the_same_active_chip_sits_at_either_edge_depending_on_arrival() {
        let widths = uniform(8, 10);
        let from_the_left = select_chip_window(&widths, Some(4), 0, 60, SEPARATOR);
        let from_the_right = select_chip_window(&widths, Some(4), 6, 60, SEPARATOR);
        assert_eq!(from_the_right.offset, 4);
        assert!(from_the_left.offset < from_the_right.offset);
        assert_eq!(from_the_left.end(), 5, "reached going right, so it is last");
    }

    #[test]
    fn a_window_that_already_shows_the_active_chip_does_not_move() {
        let widths = uniform(8, 10);
        let first = select_chip_window(&widths, Some(4), 3, 60, SEPARATOR);
        assert_eq!(first.offset, 3);
        let again = select_chip_window(&widths, Some(4), first.offset, 60, SEPARATOR);
        assert_eq!(again, first);
    }

    // Jumping into agent 8 from the dashboard does not pass through next/prev,
    // so the window has to be corrected here rather than at the jump site.
    #[test]
    fn jumping_far_forward_brings_the_active_chip_into_view() {
        let window = select_chip_window(&uniform(10, 10), Some(9), 0, 60, SEPARATOR);
        assert_eq!(window.end(), 10);
        assert!(window.offset > 0);
        assert_eq!(window.hidden_right, 0);
    }

    #[test]
    fn jumping_far_backward_brings_the_active_chip_into_view() {
        let window = select_chip_window(&uniform(10, 10), Some(1), 7, 60, SEPARATOR);
        assert_eq!(window.offset, 1);
        assert_eq!(window.hidden_left, 1);
    }

    #[test]
    fn leaves_room_for_the_markers_it_is_about_to_draw() {
        let widths = uniform(10, 10);
        let window = select_chip_window(&widths, Some(5), 3, 60, SEPARATOR);
        let separators = (window.count as i64 - 1).max(0) * SEPARATOR;
        let chips: i64 = widths[window.offset..window.end()].iter().sum();
        let markers = marker_width(window.hidden_left, SEPARATOR)
            + marker_width(window.hidden_right, SEPARATOR);
        assert!(
            chips + separators + markers <= 60,
            "window overflows the line"
        );
    }

    #[test]
    fn shows_one_chip_even_when_it_cannot_fit() {
        let window = select_chip_window(&uniform(4, 400), Some(2), 0, 60, SEPARATOR);
        assert_eq!(window.count, 1);
        assert_eq!(window.offset, 2);
    }

    #[test]
    fn no_chips_is_an_empty_window_rather_than_a_panic() {
        let window = select_chip_window(&[], None, 4, 60, SEPARATOR);
        assert_eq!(window.count, 0);
        assert_eq!(window.offset, 0);
    }
}
