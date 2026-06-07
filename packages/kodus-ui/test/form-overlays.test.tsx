/**
 * Form (RHF), AlertDialog and DatePicker.
 */
import { useState } from "react";
import { type DateRange } from "react-day-picker";
import { useForm } from "react-hook-form";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogTitle,
    AlertDialogTrigger,
    Button,
    DatePicker,
    DateRangePicker,
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
    Input,
} from "../src";

describe("Form (react-hook-form)", () => {
    function Harness({ onSubmit }: { onSubmit: (data: unknown) => void }) {
        const form = useForm({ defaultValues: { name: "" } });

        return (
            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)}>
                    <FormField
                        control={form.control}
                        name="name"
                        rules={{ required: "Rule name is required." }}
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Rule name</FormLabel>
                                <FormControl>
                                    <Input {...field} />
                                </FormControl>
                                <FormDescription>desc</FormDescription>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <Button type="submit">Save</Button>
                </form>
            </Form>
        );
    }

    it("shows validation message, marks input invalid, then submits", async () => {
        const user = userEvent.setup();
        const onSubmit = vi.fn();
        render(<Harness onSubmit={onSubmit} />);

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(
            await screen.findByText("Rule name is required."),
        ).toBeInTheDocument();
        expect(screen.getByRole("textbox")).toHaveAttribute(
            "aria-invalid",
            "true",
        );
        expect(onSubmit).not.toHaveBeenCalled();

        await user.type(
            screen.getByRole("textbox", { name: "Rule name" }),
            "no-raw-sql",
        );
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(onSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ name: "no-raw-sql" }),
            expect.anything(),
        );
        expect(
            screen.queryByText("Rule name is required."),
        ).not.toBeInTheDocument();
    });

    it("label is wired to the control", () => {
        render(<Harness onSubmit={() => {}} />);
        expect(
            screen.getByRole("textbox", { name: "Rule name" }),
        ).toBeInTheDocument();
    });
});

describe("AlertDialog", () => {
    it("confirms and cancels", async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        render(
            <AlertDialog>
                <AlertDialogTrigger asChild>
                    <Button variant="danger">Delete</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                    <AlertDialogTitle>Sure?</AlertDialogTitle>
                    <AlertDialogDescription>No undo.</AlertDialogDescription>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction destructive onClick={onConfirm}>
                            Delete rule
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>,
        );

        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(
            screen.getByRole("alertdialog", { name: "Sure?" }),
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete rule" }));
        expect(onConfirm).toHaveBeenCalled();
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
});

describe("DatePicker", () => {
    function Harness() {
        const [date, setDate] = useState<Date | null>(null);
        return <DatePicker value={date} onValueChange={setDate} />;
    }

    it("opens the calendar and picks a day", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.click(
            screen.getByRole("button", { name: "Pick a date" }),
        );
        const grid = await screen.findByRole("grid");
        expect(grid).toBeInTheDocument();

        await user.click(screen.getAllByText("15")[0]);
        expect(
            screen.getByRole("button", { name: /15, \d{4}/ }),
        ).toBeInTheDocument();
        expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    });

    it("readOnly does not open", async () => {
        const user = userEvent.setup();
        render(
            <DatePicker
                value={new Date(2026, 5, 6)}
                onValueChange={() => {}}
                readOnly
            />,
        );

        await user.click(screen.getByText(/Jun 6, 2026/));
        expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    });
});

describe("DateRangePicker", () => {
    it("applies presets and marks the active one", async () => {
        const user = userEvent.setup();

        function Harness() {
            const [range, setRange] = useState<DateRange | null>(null);
            return (
                <DateRangePicker
                    value={range}
                    onValueChange={setRange}
                    presets={[
                        {
                            label: "Last week",
                            range: () => {
                                const to = new Date();
                                const from = new Date();
                                from.setDate(to.getDate() - 7);
                                return { from, to };
                            },
                        },
                    ]}
                />
            );
        }
        render(<Harness />);

        await user.click(
            screen.getByRole("button", { name: "Pick a date range" }),
        );
        await user.click(screen.getByRole("button", { name: "Last week" }));
        expect(
            screen.getByRole("button", { name: "Last week" }),
        ).toHaveAttribute("aria-pressed", "true");
        expect(
            screen.getByRole("button", { name: /–/ }),
        ).toBeInTheDocument();
    });

    it("renders a two-month range calendar", async () => {
        const user = userEvent.setup();
        render(
            <DateRangePicker
                value={{
                    from: new Date(2026, 5, 1),
                    to: new Date(2026, 5, 7),
                }}
                onValueChange={() => {}}
            />,
        );

        expect(
            screen.getByText("Jun 1, 2026 – Jun 7, 2026"),
        ).toBeInTheDocument();
        await user.click(screen.getByText(/Jun 1, 2026/));
        expect(await screen.findAllByRole("grid")).toHaveLength(2);
    });
});
