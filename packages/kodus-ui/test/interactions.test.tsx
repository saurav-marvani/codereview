/**
 * Interaction tests for the critical components.
 */
import { useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
    Button,
    Checkbox,
    Combobox,
    Dialog,
    DialogClose,
    DialogContent,
    DialogTitle,
    DialogTrigger,
    FilterChip,
    MultiSelect,
    NumberInput,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    TablePagination,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    TagInput,
    toast,
    Toaster,
    TreeFolder,
    TreeItem,
    TreeRoot,
} from "../src";

describe("Button", () => {
    it("fires onClick and blocks when loading", async () => {
        const user = userEvent.setup();
        const onClick = vi.fn();
        const { rerender } = render(<Button onClick={onClick}>Run</Button>);

        await user.click(screen.getByRole("button", { name: "Run" }));
        expect(onClick).toHaveBeenCalledTimes(1);

        rerender(<Button onClick={onClick} loading>Run</Button>);
        expect(screen.getByRole("button")).toBeDisabled();
    });
});

describe("Switch", () => {
    it("toggles, but not when readOnly", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { rerender } = render(<Switch onCheckedChange={onChange} />);

        await user.click(screen.getByRole("switch"));
        expect(onChange).toHaveBeenCalledWith(true);

        onChange.mockClear();
        rerender(<Switch onCheckedChange={onChange} readOnly defaultChecked />);
        const sw = screen.getByRole("switch");
        expect(sw).toHaveAttribute("data-readonly");
        await user.click(sw);
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe("Checkbox", () => {
    it("checks and respects readOnly", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { rerender } = render(
            <Checkbox onCheckedChange={onChange} aria-label="pick" />,
        );

        await user.click(screen.getByRole("checkbox", { name: "pick" }));
        expect(onChange).toHaveBeenCalledWith(true);

        onChange.mockClear();
        rerender(
            <Checkbox
                onCheckedChange={onChange}
                aria-label="pick"
                readOnly
                defaultChecked
            />,
        );
        await user.click(screen.getByRole("checkbox", { name: "pick" }));
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe("Dialog", () => {
    it("opens via trigger and closes via close button", async () => {
        const user = userEvent.setup();
        render(
            <Dialog>
                <DialogTrigger asChild>
                    <Button>Delete rule</Button>
                </DialogTrigger>
                <DialogContent aria-describedby={undefined}>
                    <DialogTitle>Sure?</DialogTitle>
                    <DialogClose asChild>
                        <Button variant="ghost">Cancel</Button>
                    </DialogClose>
                </DialogContent>
            </Dialog>,
        );

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Delete rule" }));
        expect(screen.getByRole("dialog")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});

describe("Select", () => {
    it("picks an option", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
            <Select onValueChange={onChange}>
                <SelectTrigger aria-label="trigger">
                    <SelectValue placeholder="Pick" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="push">On every push</SelectItem>
                    <SelectItem value="manual">Manual only</SelectItem>
                </SelectContent>
            </Select>,
        );

        await user.click(screen.getByRole("combobox", { name: "trigger" }));
        await user.click(screen.getByRole("option", { name: "Manual only" }));
        expect(onChange).toHaveBeenCalledWith("manual");
    });
});

describe("Tabs", () => {
    it("switches content", async () => {
        const user = userEvent.setup();
        render(
            <Tabs defaultValue="a">
                <TabsList>
                    <TabsTrigger value="a">First</TabsTrigger>
                    <TabsTrigger value="b">Second</TabsTrigger>
                </TabsList>
                <TabsContent value="a">content-a</TabsContent>
                <TabsContent value="b">content-b</TabsContent>
            </Tabs>,
        );

        expect(screen.getByText("content-a")).toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Second" }));
        expect(screen.getByText("content-b")).toBeInTheDocument();
        expect(screen.queryByText("content-a")).not.toBeInTheDocument();
    });
});

describe("Combobox", () => {
    function Harness() {
        const [value, setValue] = useState<string | null>(null);
        return (
            <Combobox
                value={value}
                onValueChange={setValue}
                placeholder="Choose"
                clearable
                options={[
                    { value: "sonnet", label: "Claude Sonnet" },
                    { value: "kimi", label: "Kimi K2.6" },
                ]}
            />
        );
    }

    it("filters, selects and clears", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.click(screen.getByRole("button", { name: "Choose" }));
        await user.keyboard("kimi");
        expect(screen.queryByText("Claude Sonnet")).not.toBeInTheDocument();
        await user.click(screen.getByText("Kimi K2.6"));
        expect(
            screen.getByRole("button", { name: /Kimi K2.6/ }),
        ).toBeInTheDocument();

        await user.click(screen.getByLabelText("Clear selection"));
        expect(
            screen.getByRole("button", { name: "Choose" }),
        ).toBeInTheDocument();
    });

    it("readOnly does not open", async () => {
        const user = userEvent.setup();
        render(
            <Combobox
                value="sonnet"
                onValueChange={() => {}}
                readOnly
                options={[{ value: "sonnet", label: "Claude Sonnet" }]}
            />,
        );

        await user.click(screen.getByText("Claude Sonnet"));
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
});

describe("MultiSelect", () => {
    function Harness() {
        const [values, setValues] = useState<string[]>([]);
        return (
            <MultiSelect
                values={values}
                onValuesChange={setValues}
                placeholder="Select repos"
                options={[
                    { value: "a", label: "repo-a" },
                    { value: "b", label: "repo-b" },
                ]}
            />
        );
    }

    it("toggles items and select all", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.click(screen.getByRole("button", { name: "Select repos" }));
        await user.click(screen.getByText("repo-a"));
        expect(
            screen.getByRole("button", { name: /repo-a/ }),
        ).toBeInTheDocument();

        await user.click(screen.getByText("Select all"));
        expect(
            screen.getByRole("button", { name: /repo-a, repo-b/ }),
        ).toBeInTheDocument();

        await user.click(screen.getByText("Clear all"));
        expect(
            screen.getByRole("button", { name: "Select repos" }),
        ).toBeInTheDocument();
    });
});

describe("TagInput", () => {
    function Harness() {
        const [tags, setTags] = useState<string[]>(["kodus.io"]);
        return <TagInput tags={tags} onTagsChange={setTags} id="tags" />;
    }

    it("adds on Enter, removes via × and Backspace", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const input = screen.getByRole("textbox");

        await user.type(input, "acme.com{Enter}");
        expect(screen.getByText("acme.com")).toBeInTheDocument();

        await user.click(screen.getByLabelText("Remove kodus.io"));
        expect(screen.queryByText("kodus.io")).not.toBeInTheDocument();

        await user.type(input, "{Backspace}");
        expect(screen.queryByText("acme.com")).not.toBeInTheDocument();
    });
});

describe("NumberInput", () => {
    function Harness() {
        const [value, setValue] = useState(9);
        return (
            <NumberInput value={value} onChange={setValue} min={1} max={10} />
        );
    }

    it("steps and clamps at max", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.click(screen.getByLabelText("Increase"));
        expect(screen.getByRole("textbox")).toHaveValue("10");
        expect(screen.getByLabelText("Increase")).toBeDisabled();

        await user.click(screen.getByLabelText("Decrease"));
        expect(screen.getByRole("textbox")).toHaveValue("9");
    });
});

describe("TablePagination", () => {
    it("navigates pages and disables edges", async () => {
        const user = userEvent.setup();
        const onPageChange = vi.fn();
        render(
            <TablePagination
                page={1}
                pageCount={12}
                onPageChange={onPageChange}
            />,
        );

        expect(screen.getByRole("button", { name: "‹" })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "2" }));
        expect(onPageChange).toHaveBeenCalledWith(2);
        await user.click(screen.getByRole("button", { name: "›" }));
        expect(onPageChange).toHaveBeenCalledWith(2);
    });
});

describe("FilterChip", () => {
    it("reflects active state and fires onRemove", async () => {
        const user = userEvent.setup();
        const onRemove = vi.fn();
        render(
            <FilterChip color="critical" count={2} onRemove={onRemove}>
                Critical
            </FilterChip>,
        );

        expect(screen.getByRole("button", { name: /Critical/ }))
            .toHaveAttribute("aria-pressed", "true");
        await user.click(screen.getByLabelText("Remove filter"));
        expect(onRemove).toHaveBeenCalled();
    });
});

describe("Tree", () => {
    function Harness({ mode }: { mode: "single" | "multiple" }) {
        const [values, setValues] = useState<string[]>([]);
        return (
            <TreeRoot mode={mode} values={values} onValuesChange={setValues}>
                <TreeFolder label="kodus-ai">
                    <TreeItem value="web">web</TreeItem>
                    <TreeItem value="api">api</TreeItem>
                </TreeFolder>
            </TreeRoot>
        );
    }

    it("multi mode accumulates; single mode replaces", async () => {
        const user = userEvent.setup();
        const { unmount } = render(<Harness mode="multiple" />);

        await user.click(screen.getByRole("treeitem", { name: "web" }));
        await user.click(screen.getByRole("treeitem", { name: "api" }));
        expect(
            screen
                .getAllByRole("treeitem")
                .filter((item) => item.getAttribute("aria-selected") === "true"),
        ).toHaveLength(2);
        unmount();

        render(<Harness mode="single" />);
        await user.click(screen.getByRole("treeitem", { name: "web" }));
        await user.click(screen.getByRole("treeitem", { name: "api" }));
        const selected = screen
            .getAllByRole("treeitem")
            .filter((item) => item.getAttribute("aria-selected") === "true");
        expect(selected).toHaveLength(1);
        expect(within(selected[0]).getByText("api")).toBeInTheDocument();
    });
});

describe("Toast", () => {
    it("fires and dismisses", async () => {
        const user = userEvent.setup();
        render(<Toaster />);

        act(() => {
            toast({ title: "Review completed", duration: 0 });
        });
        expect(await screen.findByText("Review completed")).toBeInTheDocument();

        await user.click(screen.getByLabelText("Dismiss"));
        expect(screen.queryByText("Review completed")).not.toBeInTheDocument();
    });
});
