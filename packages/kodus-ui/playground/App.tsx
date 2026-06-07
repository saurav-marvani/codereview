import { useState } from "react";
import { useForm } from "react-hook-form";
import { type DateRange } from "react-day-picker";
import {
    ArrowDown,
    ArrowRight,
    ArrowUp,
    BookMarked,
    Brain,
    ChevronDown,
    CreditCard,
    Dog,
    FileText,
    GitBranch,
    GitPullRequest,
    Layers,
    MessageSquare,
    Pencil,
    Puzzle,
    Bell,
    BookOpen,
    Moon,
    Sun,
    Gauge,
    SlidersHorizontal,
    Trash2,
    TriangleAlert,
    Zap,
} from "lucide-react";

import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
    Alert,
    AlertDescription,
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogTitle,
    AlertDialogTrigger,
    AlertTitle,
    DatePicker,
    DateRangePicker,
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
    ChoiceCard,
    ChoiceCards,
    Combobox,
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    DescriptionItem,
    DescriptionList,
    EmptyState,
    ErrorCard,
    FilterChip,
    LoadingState,
    Separator,
    TagInput,
    TreeFolder,
    TreeItem,
    TreeRoot,
    HelpTip,
    IndicatorDot,
    Locked,
    Meter,
    MultiSelect,
    Navbar,
    NavbarActions,
    NavbarBrand,
    NavbarItem,
    NavbarNav,
    NumberInput,
    PasswordInput,
    RequirementList,
    SeparatorWithLabel,
    Steps,
    SliderWithMarks,
    StatCard,
    StatCardRow,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Sheet,
    SheetClose,
    SheetContent,
    SheetDescription,
    SheetTitle,
    SheetTrigger,
    Slider,
    TableContainer,
    Table,
    TableBody,
    TableCell,
    TableFooter,
    TableHead,
    TableHeader,
    TablePagination,
    TableRow,
    toast,
    Toaster,
    ToggleGroup,
    ToggleGroupItem,
    Avatar,
    AvatarStack,
    Badge,
    Breadcrumb,
    BreadcrumbCurrent,
    BreadcrumbLink,
    BreadcrumbSeparator,
    Button,
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    Checkbox,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DialogTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Field,
    FieldError,
    FieldHint,
    InlineCode,
    Input,
    Kbd,
    Label,
    PageHeader,
    Progress,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Setting,
    SettingsGroup,
    Sidebar,
    SidebarGroup,
    SidebarItem,
    SidebarScope,
    Skeleton,
    Spinner,
    Switch,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    Textarea,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "../src";

function Section({
    title,
    children,
}: React.PropsWithChildren<{ title: string }>) {
    return (
        <section className="mt-16 first:mt-0">
            <h3 className="mb-[18px] text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                {title}
            </h3>
            {children}
        </section>
    );
}

export function App() {
    const [reviewing, setReviewing] = useState(false);
    const [settingsPage, setSettingsPage] = useState("General");
    const [progress, setProgress] = useState(62);
    const [cmdOpen, setCmdOpen] = useState(false);
    const [page, setPage] = useState(1);
    const [maxSuggestions, setMaxSuggestions] = useState(18);
    const [concurrent, setConcurrent] = useState(3);
    const [severity, setSeverity] = useState(2);
    const [sortBy, setSortBy] = useState<"user" | "email">("user");
    const [criticalOn, setCriticalOn] = useState(true);
    const [highOn, setHighOn] = useState(true);
    const [password, setPassword] = useState("");
    const [repos, setRepos] = useState<string[]>([]);
    const [wizardStep, setWizardStep] = useState(4);
    const [navPage, setNavPage] = useState("Pull Requests");
    const [date, setDate] = useState<Date | null>(null);
    const [range, setRange] = useState<DateRange | null>(null);
    const ruleForm = useForm({
        defaultValues: { name: "", webhookUrl: "" },
    });
    const [light, setLight] = useState(false);
    const toggleTheme = () => {
        document.documentElement.classList.toggle("light", !light);
        setLight(!light);
    };
    const [domains, setDomains] = useState(["kodus.io"]);
    const [treeValues, setTreeValues] = useState(["apps/web"]);
    const [model, setModel] = useState<string | null>("sonnet");

    return (
        <TooltipProvider delayDuration={200}>
            <div className="mx-auto max-w-[1180px] px-8 pt-12 pb-32">
                <div className="flex items-center gap-4">
                    <h1 className="text-[26px] font-bold tracking-[-0.02em]">
                        kodus<span className="text-accent">·ds</span>{" "}
                        playground
                    </h1>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={toggleTheme}
                        leftIcon={
                            light ? (
                                <Moon className="size-3.5" />
                            ) : (
                                <Sun className="size-3.5" />
                            )
                        }>
                        {light ? "Dark" : "Light"}
                    </Button>
                </div>
                <p className="mt-1.5 text-text-2">
                    Real components from <InlineCode>@kodus/ui</InlineCode>.
                    Everything below is live: click, hover, tab through it.
                </p>

                <Section title="Buttons">
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            loading={reviewing}
                            onClick={() => {
                                setReviewing(true);
                                setTimeout(() => setReviewing(false), 2500);
                            }}>
                            {reviewing ? "Reviewing" : "Run review"}
                        </Button>
                        <Button variant="secondary">Configure</Button>
                        <Button variant="ghost">Cancel</Button>
                        <Button variant="danger">Delete rule</Button>
                        <Button variant="primary" disabled>
                            Disabled
                        </Button>
                        <Button variant="secondary" size="sm">
                            Sync repos
                        </Button>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                        <Button leftIcon={<Zap className="size-3.5" />}>
                            Run review
                        </Button>
                        <Button
                            variant="secondary"
                            leftIcon={<GitBranch className="size-3.5" />}>
                            Connect repo
                        </Button>
                        <Button
                            variant="secondary"
                            rightIcon={<ArrowRight className="size-3.5" />}>
                            Next step
                        </Button>
                        <Button
                            variant="ghost"
                            leftIcon={<MessageSquare className="size-3.5" />}>
                            Comments
                        </Button>
                        <Button
                            variant="secondary"
                            size="icon"
                            aria-label="Edit">
                            <Pencil className="size-3.5" />
                        </Button>
                        <Button
                            variant="danger"
                            size="icon"
                            aria-label="Delete">
                            <Trash2 className="size-3.5" />
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            leftIcon={<Pencil className="size-3" />}>
                            Edit
                        </Button>
                    </div>
                </Section>

                <Section title="Inputs · select · textarea">
                    <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                        <div className="flex flex-col gap-4">
                            <Field>
                                <Label htmlFor="repo">
                                    Search repositories
                                </Label>
                                <Input
                                    id="repo"
                                    placeholder="kodustech/kodus-ai"
                                    rightSlot={
                                        <Kbd className="text-[10px]">/</Kbd>
                                    }
                                />
                                <FieldHint>
                                    Searches across all connected
                                    organizations.
                                </FieldHint>
                            </Field>
                            <Field>
                                <Label htmlFor="hook">Webhook URL</Label>
                                <Input
                                    id="hook"
                                    defaultValue="htp://hooks.kodus"
                                    aria-invalid
                                />
                                <FieldError>
                                    Must be a valid HTTPS URL.
                                </FieldError>
                            </Field>
                        </div>
                        <div className="flex flex-col gap-4">
                            <Field>
                                <Label>Review trigger</Label>
                                <Select defaultValue="push">
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="push">
                                            On every push
                                        </SelectItem>
                                        <SelectItem value="open">
                                            When PR is opened
                                        </SelectItem>
                                        <SelectItem value="ready">
                                            When marked ready for review
                                        </SelectItem>
                                        <SelectItem value="manual">
                                            Manual only
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field className="max-w-none">
                                <Label htmlFor="rule">Rule instructions</Label>
                                <Textarea
                                    id="rule"
                                    placeholder="Describe what Kody should enforce…"
                                />
                            </Field>
                        </div>
                    </div>
                </Section>

                <Section title="Input states — the full matrix">
                    <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-3">
                        <Field>
                            <Label>Default</Label>
                            <Input placeholder="Type here" />
                        </Field>
                        <Field>
                            <Label>Focused (click in)</Label>
                            <Input defaultValue="kodus-ai" />
                        </Field>
                        <Field>
                            <Label>Invalid</Label>
                            <Input defaultValue="htp://wrong" aria-invalid />
                        </Field>
                        <Field>
                            <Label>Loading (async check)</Label>
                            <Input defaultValue="kodustech/kodus-ai" loading />
                        </Field>
                        <Field>
                            <Label>Read-only</Label>
                            <Input
                                defaultValue=".cursor/rules/react.mdc"
                                readOnly
                            />
                        </Field>
                        <Field>
                            <Label>Disabled</Label>
                            <Input defaultValue="kd_••••••3f2a" disabled />
                        </Field>
                        <Field className="max-w-none">
                            <Label htmlFor="domains">
                                Tag input — approved domains
                            </Label>
                            <TagInput
                                id="domains"
                                tags={domains}
                                onTagsChange={setDomains}
                                placeholder="Add a domain and press Enter"
                            />
                            <FieldHint>
                                Separate multiple domains with a comma.
                            </FieldHint>
                        </Field>
                        <Field>
                            <Label>Textarea invalid</Label>
                            <Textarea
                                aria-invalid
                                defaultValue="too short"
                                className="min-h-[60px]"
                            />
                            <FieldError>
                                Instructions must be at least 20 characters.
                            </FieldError>
                        </Field>
                        <Field>
                            <Label>Select invalid</Label>
                            <Select>
                                <SelectTrigger aria-invalid>
                                    <SelectValue placeholder="Pick a trigger" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="push">
                                        On every push
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <FieldError>Required.</FieldError>
                        </Field>
                    </div>
                </Section>

                <Section title="Read-only by permission — readOnly + Locked (hover the locks)">
                    <div className="max-w-[680px]">
                        <SettingsGroup
                            title="Repository settings"
                            description="Viewer role: values visible, editing locked">
                            <Setting
                                title="Automated code review"
                                description="Kody reviews every new pull request automatically."
                                lockedReason="Requires the Repo Admin role."
                                control={<Switch defaultChecked readOnly />}
                            />
                            <Setting
                                title="Review cadence"
                                description="How Kody runs follow-up reviews."
                                lockedReason="Requires the Repo Admin role."
                                control={
                                    <Select defaultValue="auto">
                                        <SelectTrigger
                                            readOnly
                                            className="w-[180px]">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="auto">
                                                Automatic
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                }
                            />
                            <Setting
                                title="Cross-file analysis"
                                description="Resolve callers and types across the repository."
                                lockedReason="Requires the Repo Admin role."
                                control={<Switch defaultChecked readOnly />}
                            />
                        </SettingsGroup>
                        <div className="mt-4 flex items-center gap-6">
                            <Locked reason="Only the workspace Owner can save global settings.">
                                <Button disabled>Save settings</Button>
                            </Locked>
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <Checkbox defaultChecked readOnly /> readOnly
                                checkbox (legible, not faded)
                            </label>
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <Checkbox defaultChecked disabled /> disabled
                                (faded)
                            </label>
                        </div>
                    </div>
                </Section>

                <Section title="Switch · checkbox · radio">
                    <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
                        <div className="flex flex-col gap-4">
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <Switch /> Draft PRs
                            </label>
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <Switch defaultChecked /> Cross-file analysis
                            </label>
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <Switch defaultChecked loading /> Kody Rules{" "}
                                <span className="text-xs text-text-3">
                                    saving…
                                </span>
                            </label>
                        </div>
                        <div className="flex flex-col gap-4">
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <Checkbox /> kodus-ai
                            </label>
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <Checkbox defaultChecked /> kodus-installer
                            </label>
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <Checkbox checked="indeterminate" /> All
                                repositories
                            </label>
                        </div>
                        <RadioGroup defaultValue="light">
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <RadioGroupItem value="light" /> Light — bugs
                                only
                            </label>
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <RadioGroupItem value="standard" /> Standard —
                                bugs + rules
                            </label>
                            <label className="flex items-center gap-2.5 text-[13.5px] text-text-2">
                                <RadioGroupItem value="deep" /> Deep —
                                cross-file context
                            </label>
                        </RadioGroup>
                    </div>
                </Section>

                <Section title="Badges">
                    <div className="flex flex-wrap gap-3">
                        <Badge variant="critical">Critical</Badge>
                        <Badge variant="high">High</Badge>
                        <Badge variant="medium">Medium</Badge>
                        <Badge variant="low">Low</Badge>
                        <Badge variant="success">Merged</Badge>
                        <Badge variant="violet">In review</Badge>
                        <Badge variant="alert">Pending</Badge>
                        <Badge variant="violet" dot={false}>
                            Kody Rule
                        </Badge>
                    </div>
                </Section>

                <Section title="Tabs">
                    <Tabs defaultValue="findings">
                        <TabsList>
                            <TabsTrigger value="findings" count={12}>
                                Findings
                            </TabsTrigger>
                            <TabsTrigger value="files" count={34}>
                                Files
                            </TabsTrigger>
                            <TabsTrigger value="rules" count={5}>
                                Kody Rules
                            </TabsTrigger>
                            <TabsTrigger value="activity">
                                Activity
                            </TabsTrigger>
                        </TabsList>
                        <TabsContent
                            value="findings"
                            className="text-[13px] text-text-2">
                            12 findings across 8 files. 1 critical, 2 high.
                        </TabsContent>
                        <TabsContent
                            value="files"
                            className="text-[13px] text-text-2">
                            34 files changed, +812 −245.
                        </TabsContent>
                        <TabsContent
                            value="rules"
                            className="text-[13px] text-text-2">
                            5 rules evaluated, 2 violated.
                        </TabsContent>
                        <TabsContent
                            value="activity"
                            className="text-[13px] text-text-2">
                            Review started 2 minutes ago by Kody.
                        </TabsContent>
                    </Tabs>
                </Section>

                <Section title="Overlays — tooltip · dropdown · dialog">
                    <div className="flex flex-wrap items-center gap-3">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="secondary">Hover me</Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Re-run review on latest commit
                            </TooltipContent>
                        </Tooltip>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="secondary" rightIcon={<ChevronDown className="size-3.5" />}>
                                    PR actions
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                                <DropdownMenuLabel>
                                    Pull request
                                </DropdownMenuLabel>
                                <DropdownMenuItem shortcut="⌘R">
                                    Re-run review
                                </DropdownMenuItem>
                                <DropdownMenuItem shortcut="⌘C">
                                    Copy PR link
                                </DropdownMenuItem>
                                <DropdownMenuItem>
                                    Open on GitHub
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem destructive>
                                    Dismiss all findings
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <Dialog>
                            <DialogTrigger asChild>
                                <Button variant="danger">
                                    Delete Kody Rule
                                </Button>
                            </DialogTrigger>
                            <DialogContent>
                                <DialogTitle>
                                    Delete this Kody Rule?
                                </DialogTitle>
                                <DialogDescription>
                                    <InlineCode>
                                        no-raw-sql-in-controllers
                                    </InlineCode>{" "}
                                    is active in 12 repositories. Reviews
                                    already posted keep their comments; future
                                    reviews stop enforcing it.
                                </DialogDescription>
                                <DialogFooter>
                                    <DialogClose asChild>
                                        <Button variant="ghost">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                        <Button variant="danger">
                                            Delete rule
                                        </Button>
                                    </DialogClose>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                    </div>
                </Section>

                <Section title="Overlays 2 — popover · sheet · ⌘K · toast">
                    <div className="flex flex-wrap items-center gap-3">
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="secondary">
                                    Auto-assign reviewers
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent>
                                <h4 className="text-sm font-semibold">
                                    Auto-assign reviewers
                                </h4>
                                <p className="mt-1.5 text-[12.5px] text-text-2">
                                    Kody picks reviewers from CODEOWNERS and
                                    recent file history.
                                </p>
                                <div className="mt-3 flex gap-2">
                                    <Button size="sm">Enable</Button>
                                    <Button size="sm" variant="ghost">
                                        Learn more
                                    </Button>
                                </div>
                            </PopoverContent>
                        </Popover>

                        <Sheet>
                            <SheetTrigger asChild>
                                <Button variant="secondary">
                                    Open side panel
                                </Button>
                            </SheetTrigger>
                            <SheetContent>
                                <SheetTitle className="text-base font-bold">
                                    Rule details
                                </SheetTitle>
                                <SheetDescription className="mt-2 text-sm text-text-2">
                                    no-raw-sql-in-controllers — active in 12
                                    repositories, 47 violations caught this
                                    month.
                                </SheetDescription>
                                <div className="mt-auto flex justify-end gap-2">
                                    <SheetClose asChild>
                                        <Button variant="ghost">Close</Button>
                                    </SheetClose>
                                </div>
                            </SheetContent>
                        </Sheet>

                        <Button
                            variant="secondary"
                            onClick={() => setCmdOpen(true)}>
                            Command palette <Kbd>⌘K</Kbd>
                        </Button>
                        <CommandDialog
                            open={cmdOpen}
                            onOpenChange={setCmdOpen}>
                            <CommandInput placeholder="Search repos, PRs, rules…" />
                            <CommandList>
                                <CommandEmpty>No results.</CommandEmpty>
                                <CommandGroup heading="Kody Rules">
                                    <CommandItem shortcut="↵">
                                        no-raw-sql-in-controllers
                                    </CommandItem>
                                    <CommandItem>
                                        require-error-boundaries
                                    </CommandItem>
                                </CommandGroup>
                                <CommandGroup heading="Actions">
                                    <CommandItem>
                                        Create Kody Rule…
                                    </CommandItem>
                                    <CommandItem>Re-run review</CommandItem>
                                </CommandGroup>
                            </CommandList>
                        </CommandDialog>

                        <Button
                            variant="secondary"
                            onClick={() =>
                                toast({
                                    title: "Review completed",
                                    description:
                                        "12 findings on kodus-ai #1280.",
                                    variant: "success",
                                    action: {
                                        label: "View",
                                        onClick: () => {},
                                    },
                                })
                            }>
                            Fire toast
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={() =>
                                toast({
                                    title: "Webhook delivery failed",
                                    description:
                                        "GitHub returned 502. Retrying in 30s.",
                                    variant: "error",
                                })
                            }>
                            Fire error toast
                        </Button>
                    </div>
                </Section>

                <Section title="Feedback — alerts">
                    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                        <Alert variant="info">
                            <AlertTitle>Trial: 9 days left</AlertTitle>
                            <AlertDescription>
                                Connect billing to keep reviews running.
                            </AlertDescription>
                        </Alert>
                        <Alert variant="warning">
                            <AlertTitle>Rate limit at 80%</AlertTitle>
                            <AlertDescription>
                                GitHub API quota resets in 22 minutes.
                            </AlertDescription>
                        </Alert>
                        <Alert variant="danger">
                            <AlertTitle>License expired</AlertTitle>
                            <AlertDescription>
                                Self-hosted reviews are paused.
                            </AlertDescription>
                        </Alert>
                        <Alert variant="success">
                            <AlertTitle>All checks passed</AlertTitle>
                            <AlertDescription>
                                This PR meets every active Kody Rule.
                            </AlertDescription>
                        </Alert>
                    </div>
                </Section>

                <Section title="Loading — skeleton · spinner · progress">
                    <div className="grid grid-cols-1 items-start gap-8 md:grid-cols-2">
                        <Card>
                            <CardHeader>
                                <Skeleton className="h-3 w-[220px]" />
                                <Skeleton className="ml-auto h-5 w-16 rounded-full" />
                            </CardHeader>
                            <CardContent>
                                <Skeleton className="h-[15px] w-3/5" />
                                <Skeleton className="mt-2.5 h-3 w-[90%]" />
                                <Skeleton className="mt-1.5 h-3 w-3/4" />
                            </CardContent>
                        </Card>
                        <div className="flex flex-col gap-6">
                            <div className="flex items-center gap-5">
                                <Spinner size="md" />
                                <Spinner size="lg" />
                                <Spinner size="md" variant="muted" />
                            </div>
                            <Field>
                                <Label>
                                    Reviewing files — {progress}% (click)
                                </Label>
                                <button
                                    onClick={() =>
                                        setProgress((p) =>
                                            p >= 100 ? 10 : p + 15,
                                        )
                                    }>
                                    <Progress value={progress} />
                                </button>
                            </Field>
                        </div>
                    </div>
                </Section>

                <Section title="Table · pagination">
                    <TableContainer>
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <TableHead>Repository</TableHead>
                                    <TableHead>Pull request</TableHead>
                                    <TableHead className="text-right">
                                        Findings
                                    </TableHead>
                                    <TableHead>Severity</TableHead>
                                    <TableHead>Status</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                <TableRow>
                                    <TableCell className="font-semibold">
                                        kodus-ai
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-text-3">
                                        #1283 · ci: discord ping on RC
                                    </TableCell>
                                    <TableCell numeric>0</TableCell>
                                    <TableCell>
                                        <Badge variant="low">None</Badge>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant="success">Merged</Badge>
                                    </TableCell>
                                </TableRow>
                                <TableRow>
                                    <TableCell className="font-semibold">
                                        kodus-installer
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-text-3">
                                        #21 · fix: respect IMAGE_TAG
                                    </TableCell>
                                    <TableCell numeric>3</TableCell>
                                    <TableCell>
                                        <Badge variant="high">High</Badge>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant="violet">
                                            In review
                                        </Badge>
                                    </TableCell>
                                </TableRow>
                                <TableRow>
                                    <TableCell className="font-semibold">
                                        kodus-ai
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-text-3">
                                        #1280 · fix: kody rules authz
                                    </TableCell>
                                    <TableCell numeric>7</TableCell>
                                    <TableCell>
                                        <Badge variant="critical">
                                            Critical
                                        </Badge>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant="violet">
                                            In review
                                        </Badge>
                                    </TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>
                        <TableFooter>
                            <span>48 pull requests</span>
                            <TablePagination
                                page={page}
                                pageCount={12}
                                onPageChange={setPage}
                            />
                        </TableFooter>
                    </TableContainer>
                </Section>

                <Section title="Accordion · toggle group · slider · number input">
                    <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                        <Accordion type="single" collapsible defaultValue="a">
                            <AccordionItem value="a">
                                <AccordionTrigger>
                                    Which files does Kody analyze?
                                </AccordionTrigger>
                                <AccordionContent>
                                    Every file changed in the PR, plus
                                    cross-file context: callers,
                                    implementations and type definitions of
                                    changed symbols.
                                </AccordionContent>
                            </AccordionItem>
                            <AccordionItem value="b">
                                <AccordionTrigger>
                                    Can I scope a rule to one repository?
                                </AccordionTrigger>
                                <AccordionContent>
                                    Yes — rules accept a repository scope, and
                                    repos can override global settings.
                                </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                        <div className="flex flex-col gap-6">
                            <ToggleGroup type="single" defaultValue="week">
                                <ToggleGroupItem value="day">
                                    Day
                                </ToggleGroupItem>
                                <ToggleGroupItem value="week">
                                    Week
                                </ToggleGroupItem>
                                <ToggleGroupItem value="month">
                                    Month
                                </ToggleGroupItem>
                            </ToggleGroup>
                            <Field>
                                <Label>
                                    Max suggestions per PR — {maxSuggestions}
                                </Label>
                                <Slider
                                    value={[maxSuggestions]}
                                    onValueChange={([next]) =>
                                        setMaxSuggestions(next)
                                    }
                                    min={1}
                                    max={30}
                                />
                            </Field>
                            <Field>
                                <Label>Concurrent reviews</Label>
                                <NumberInput
                                    value={concurrent}
                                    onChange={setConcurrent}
                                    min={1}
                                    max={10}
                                />
                            </Field>
                        </div>
                    </div>
                </Section>

                <Section title="Choice cards · slider with marks · help tip">
                    <div className="flex flex-col gap-7">
                        <Field className="max-w-none">
                            <Label>
                                Execution mode{" "}
                                <HelpTip>
                                    How many times this rule runs during a
                                    review.
                                </HelpTip>
                            </Label>
                            <ChoiceCards defaultValue="file">
                                <ChoiceCard
                                    value="file"
                                    icon={<FileText className="size-4" />}
                                    title="Per file"
                                    description="Runs once for each changed file"
                                    detail="→ Inline review comments"
                                />
                                <ChoiceCard
                                    value="pr"
                                    icon={<GitPullRequest className="size-4" />}
                                    title="Per PR"
                                    description="Runs once for the whole PR"
                                    detail="→ Single PR comment"
                                />
                            </ChoiceCards>
                        </Field>
                        <Field className="max-w-none">
                            <Label>
                                Severity{" "}
                                <HelpTip>
                                    Choose how violations will be classified.
                                </HelpTip>
                            </Label>
                            <SliderWithMarks
                                marks={["Low", "Medium", "High", "Critical"]}
                                value={severity}
                                onValueChange={setSeverity}
                            />
                        </Field>
                    </div>
                </Section>

                <Section title="Filter chips · description list">
                    <div className="flex gap-2">
                        <FilterChip
                            color="critical"
                            count={2}
                            active={criticalOn}
                            onClick={() => setCriticalOn((on) => !on)}>
                            Critical
                        </FilterChip>
                        <FilterChip
                            color="high"
                            count={7}
                            active={highOn}
                            onClick={() => setHighOn((on) => !on)}>
                            High
                        </FilterChip>
                        <FilterChip color="violet" onRemove={() => {}}>
                            Auto-sync
                        </FilterChip>
                    </div>
                    <Card className="mt-5">
                        <CardContent>
                            <DescriptionList>
                                <DescriptionItem label="Path">
                                    frontend/**/*.ts, frontend/**/*.tsx
                                </DescriptionItem>
                                <DescriptionItem label="Source">
                                    .cursor/rules/react-typescript.mdc
                                </DescriptionItem>
                                <DescriptionItem label="Scope" mono={false}>
                                    File
                                </DescriptionItem>
                            </DescriptionList>
                        </CardContent>
                    </Card>
                </Section>

                <Section title="Kody Rule card — pure composition (Card + Checkbox + Badge + DescriptionList)">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <Card>
                            <CardHeader className="items-start">
                                <div className="min-w-0 flex-1">
                                    <h3 className="text-[15px] font-semibold">
                                        React/TypeScript Architecture with Kea
                                    </h3>
                                    <div className="mt-2 flex items-center gap-2">
                                        <Checkbox aria-label="Select rule" />
                                        <Badge variant="high">High</Badge>
                                        <Badge variant="violet" dot={false}>
                                            Auto-sync
                                        </Badge>
                                    </div>
                                </div>
                                <div className="flex shrink-0 gap-1.5">
                                    <Button
                                        variant="secondary"
                                        size="icon"
                                        aria-label="Comments">
                                        <MessageSquare className="size-3.5" />
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        size="icon"
                                        aria-label="Edit">
                                        <Pencil className="size-3.5" />
                                    </Button>
                                    <Button
                                        variant="danger"
                                        size="icon"
                                        aria-label="Delete">
                                        <Trash2 className="size-3.5" />
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <DescriptionList>
                                    <DescriptionItem label="Path">
                                        frontend/**/*.ts, frontend/**/*.tsx
                                    </DescriptionItem>
                                    <DescriptionItem label="Source">
                                        .cursor/rules/react-typescript.mdc
                                    </DescriptionItem>
                                    <DescriptionItem
                                        label="Scope"
                                        mono={false}>
                                        File
                                    </DescriptionItem>
                                </DescriptionList>
                                <div className="mt-4">
                                    <h4 className="text-[12.5px] font-semibold text-text-2">
                                        Instructions
                                    </h4>
                                    <p className="mt-1 line-clamp-3 text-[13px] text-text-2">
                                        Implement data layer in Kea logic;
                                        avoid React state (useState/useEffect)
                                        except for library components. Use
                                        TypeScript with proper typing. Naming:
                                        Logics are camelCase, Components are
                                        PascalCase.
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="items-start">
                                <div className="min-w-0 flex-1">
                                    <h3 className="text-[15px] font-semibold">
                                        Prohibit hardcoded secrets and API
                                        keys
                                    </h3>
                                    <div className="mt-2 flex items-center gap-2">
                                        <Checkbox
                                            defaultChecked
                                            aria-label="Select rule"
                                        />
                                        <Badge variant="critical">
                                            Critical
                                        </Badge>
                                    </div>
                                </div>
                                <div className="flex shrink-0 gap-1.5">
                                    <Button
                                        variant="secondary"
                                        size="icon"
                                        aria-label="Edit">
                                        <Pencil className="size-3.5" />
                                    </Button>
                                    <Button
                                        variant="danger"
                                        size="icon"
                                        aria-label="Delete">
                                        <Trash2 className="size-3.5" />
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <DescriptionList className="md:grid-cols-2">
                                    <DescriptionItem label="Path">
                                        **/*
                                    </DescriptionItem>
                                    <DescriptionItem
                                        label="Scope"
                                        mono={false}>
                                        File
                                    </DescriptionItem>
                                </DescriptionList>
                                <p className="mt-4 line-clamp-2 text-[13px] text-text-2">
                                    Code must not contain hardcoded secrets,
                                    API keys, passwords, or private tokens.
                                    Use environment variables via process.env.
                                </p>
                            </CardContent>
                            <CardFooter>
                                <span className="inline-flex items-center gap-1.5 text-xs text-warning">
                                    <TriangleAlert className="size-3.5" /> 2 sync errors
                                </span>
                            </CardFooter>
                        </Card>
                    </div>
                </Section>

                <Section title="Stat cards · meter">
                    <StatCardRow>
                        <StatCard
                            icon={<ArrowDown className="size-3.5" />}
                            label="Input Tokens"
                            value="3.77M"
                        />
                        <StatCard
                            icon={<ArrowUp className="size-3.5" />}
                            label="Output Tokens"
                            value="97.4K"
                        />
                        <StatCard
                            icon={<Layers className="size-3.5" />}
                            label="Total Tokens"
                            value="3.86M"
                        />
                        <StatCard
                            icon={<Brain className="size-3.5" />}
                            label="Reasoning"
                            value="0"
                            hint={
                                <HelpTip>
                                    Reasoning tokens billed separately by some
                                    providers.
                                </HelpTip>
                            }
                        />
                    </StatCardRow>
                    <Card className="mt-3">
                        <CardContent>
                            <Meter
                                label="Monthly spend limit (BYOK)"
                                value={0.62}
                                max={1}
                                formatValue={(current, total) =>
                                    `$${current.toFixed(2)} of $${total}`
                                }
                            />
                        </CardContent>
                    </Card>
                </Section>

                <Section title="Sortable table">
                    <TableContainer>
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <TableHead
                                        sort={sortBy === "user" ? "asc" : false}
                                        onSort={() => setSortBy("user")}>
                                        Username
                                    </TableHead>
                                    <TableHead
                                        sort={
                                            sortBy === "email" ? "asc" : false
                                        }
                                        onSort={() => setSortBy("email")}>
                                        Email
                                    </TableHead>
                                    <TableHead>Role</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                <TableRow>
                                    <TableCell className="font-semibold">
                                        gabriel
                                    </TableCell>
                                    <TableCell className="text-text-2">
                                        kimi@codingplan.com
                                    </TableCell>
                                    <TableCell>Owner</TableCell>
                                </TableRow>
                                <TableRow>
                                    <TableCell className="font-semibold">
                                        gabrielmalinosqui
                                    </TableCell>
                                    <TableCell className="text-text-2">
                                        gabrielmalinosqui@gmail.com
                                    </TableCell>
                                    <TableCell>Repo Admin</TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Section>

                <Section title="Empty · error · loading states">
                    <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-3">
                        <EmptyState
                            icon={<BookMarked className="size-5" />}
                            title="No Kody Rules yet"
                            description="Rules turn your team's conventions into automated review comments."
                            action={<Button size="sm">Create first rule</Button>}
                        />
                        <div className="flex flex-col gap-3">
                            <ErrorCard
                                message="Couldn't load pull requests."
                                onRetry={() => {}}
                            />
                            <ErrorCard
                                variant="inline"
                                message="Webhook delivery failed."
                                onRetry={() => {}}
                            />
                            <ErrorCard
                                variant="minimal"
                                message="Sync failed."
                            />
                        </div>
                        <LoadingState />
                    </div>
                </Section>

                <Section title="Tree · dashed separator">
                    <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                        <TreeRoot
                            values={treeValues}
                            onValuesChange={setTreeValues}
                            className="max-w-[340px]">
                            <TreeFolder label="kodus-ai">
                                <TreeItem value="apps/web">apps/web</TreeItem>
                                <TreeItem value="apps/api">apps/api</TreeItem>
                                <TreeFolder
                                    label="packages"
                                    defaultOpen={false}>
                                    <TreeItem value="packages/kodus-ui">
                                        kodus-ui
                                    </TreeItem>
                                    <TreeItem value="packages/kodus-flow">
                                        kodus-flow
                                    </TreeItem>
                                </TreeFolder>
                            </TreeFolder>
                            <TreeFolder label="kodus-installer" defaultOpen={false}>
                                <TreeItem value="installer/compose">
                                    compose
                                </TreeItem>
                            </TreeFolder>
                        </TreeRoot>
                        <div className="flex flex-col gap-4 text-[13px] text-text-2">
                            <span>Solid separator</span>
                            <Separator />
                            <span>Dashed separator</span>
                            <Separator dashed />
                            <span className="text-text-3">
                                Selected: {treeValues.join(", ") || "none"}
                            </span>
                        </div>
                    </div>
                </Section>

                <Section title="Avatars">
                    <div className="flex items-center gap-6">
                        <Avatar size="lg" variant="violet">
                            K
                        </Avatar>
                        <Avatar online>GM</Avatar>
                        <Avatar variant="accent">JS</Avatar>
                        <Avatar size="sm">RT</Avatar>
                        <AvatarStack>
                            <Avatar>GM</Avatar>
                            <Avatar variant="accent">JS</Avatar>
                            <Avatar variant="violet">K</Avatar>
                            <Avatar variant="muted">+4</Avatar>
                        </AvatarStack>
                    </div>
                </Section>

                <Section title="Auth — password · requirements · separator label · lg button">
                    <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                        <div className="flex flex-col gap-4">
                            <Button
                                variant="secondary"
                                size="lg"
                                className="w-full">
                                Sign in with Github
                            </Button>
                            <SeparatorWithLabel>
                                Or sign in with
                            </SeparatorWithLabel>
                            <Field className="max-w-none">
                                <Label htmlFor="auth-email">Email</Label>
                                <Input
                                    id="auth-email"
                                    placeholder="Your corporate email address"
                                />
                            </Field>
                            <Button size="lg" className="w-full" rightIcon={<ArrowRight className="size-4" />}>
                                Continue
                            </Button>
                        </div>
                        <Field className="max-w-none">
                            <Label htmlFor="pw">Password (type here)</Label>
                            <PasswordInput
                                id="pw"
                                value={password}
                                onChange={(event) =>
                                    setPassword(event.target.value)
                                }
                                placeholder="••••••••"
                            />
                            <RequirementList
                                className="mt-1"
                                title="You must have at least:"
                                requirements={[
                                    {
                                        label: "8 characters",
                                        met: password.length >= 8,
                                    },
                                    {
                                        label: "1 uppercase letter",
                                        met: /[A-Z]/.test(password),
                                    },
                                    {
                                        label: "1 number",
                                        met: /\d/.test(password),
                                    },
                                    {
                                        label: "1 symbol",
                                        met: /[^A-Za-z0-9]/.test(password),
                                    },
                                ]}
                            />
                        </Field>
                    </div>
                </Section>

                <Section title="Onboarding — steps · multi-select · choice cards (badge/media)">
                    <div className="flex flex-col gap-6">
                        <div className="flex items-center gap-4">
                            <Steps total={8} current={wizardStep} />
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    setWizardStep((step) =>
                                        step >= 8 ? 1 : step + 1,
                                    )
                                }>
                                Next step
                            </Button>
                        </div>
                        <div className="grid max-w-[900px] grid-cols-1 gap-6 md:grid-cols-2">
                            <Field className="max-w-none">
                                <Label>
                                    Combobox (single) — BYOK model
                                </Label>
                                <Combobox
                                    value={model}
                                    onValueChange={setModel}
                                    clearable
                                    placeholder="Choose a model…"
                                    searchPlaceholder="Search models…"
                                    options={[
                                        {
                                            value: "sonnet",
                                            label: "Claude Sonnet 4.6",
                                            description:
                                                "Anthropic · balanced quality and cost",
                                        },
                                        {
                                            value: "opus",
                                            label: "Claude Opus 4.7",
                                            description:
                                                "Anthropic · highest quality",
                                        },
                                        {
                                            value: "gpt",
                                            label: "GPT-5.4",
                                            description: "OpenAI",
                                        },
                                        {
                                            value: "kimi",
                                            label: "Kimi K2.6",
                                            description: "Moonshot",
                                        },
                                        {
                                            value: "glm",
                                            label: "GLM-5.1 (soon)",
                                            description: "Zhipu",
                                            disabled: true,
                                        },
                                    ]}
                                />
                                <FieldHint>
                                    Single-select autocomplete; type to
                                    filter.
                                </FieldHint>
                            </Field>
                            <Field className="max-w-none">
                                <Label>Combobox readOnly</Label>
                                <Combobox
                                    value="sonnet"
                                    onValueChange={() => {}}
                                    readOnly
                                    options={[
                                        {
                                            value: "sonnet",
                                            label: "Claude Sonnet 4.6",
                                        },
                                    ]}
                                />
                            </Field>
                        </div>
                        <Field className="max-w-[440px]">
                            <Label>Select repositories</Label>
                            <MultiSelect
                                placeholder="Select repositories…"
                                searchPlaceholder="Search repository…"
                                values={repos}
                                onValuesChange={setRepos}
                                options={[
                                    {
                                        value: "keycloak",
                                        label: "kodus-e2e/keycloak-kimi-k2-6",
                                        description:
                                            "Last activity about 14 hours ago",
                                    },
                                    {
                                        value: "tiny-url",
                                        label: "kodus-e2e/tiny-url",
                                        description:
                                            "Last activity about 14 hours ago",
                                    },
                                    {
                                        value: "discourse",
                                        label: "kodus-e2e/discourse-cursor-glm-5-1",
                                        description:
                                            "Last activity about 15 hours ago",
                                    },
                                    {
                                        value: "kodus-ai",
                                        label: "kodustech/kodus-ai",
                                        description:
                                            "Last activity 2 hours ago",
                                    },
                                ]}
                            />
                            <FieldHint>
                                Recommended: repos with recent PR activity
                            </FieldHint>
                        </Field>
                        <ChoiceCards defaultValue="speed">
                            <ChoiceCard
                                value="default"
                                hideIndicator
                                media={
                                    <Avatar size="lg" variant="violet">
                                        <Dog className="size-5" />
                                    </Avatar>
                                }
                                title="Default"
                                description="Balanced review with a steady amount of comments."
                            />
                            <ChoiceCard
                                value="speed"
                                hideIndicator
                                badge="Recommended based on your repo"
                                media={
                                    <Avatar size="lg" variant="accent">
                                        <Zap className="size-5" />
                                    </Avatar>
                                }
                                title="Speed"
                                description="Only high impact issues. Minimal comments."
                            />
                        </ChoiceCards>
                    </div>
                </Section>

                <Section title="Form (react-hook-form) · alert dialog · date picker">
                    <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                        <Form {...ruleForm}>
                            <form
                                className="flex flex-col gap-4"
                                onSubmit={ruleForm.handleSubmit((data) =>
                                    toast({
                                        title: "Rule saved",
                                        description: `${data.name} → ${data.webhookUrl}`,
                                        variant: "success",
                                    }),
                                )}>
                                <FormField
                                    control={ruleForm.control}
                                    name="name"
                                    rules={{
                                        required: "Rule name is required.",
                                        minLength: {
                                            value: 4,
                                            message:
                                                "At least 4 characters.",
                                        },
                                    }}
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Rule name</FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="no-raw-sql-in-controllers"
                                                    {...field}
                                                />
                                            </FormControl>
                                            <FormDescription>
                                                Kebab-case, unique per repo.
                                            </FormDescription>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={ruleForm.control}
                                    name="webhookUrl"
                                    rules={{
                                        pattern: {
                                            value: /^https:\/\//,
                                            message:
                                                "Must be a valid HTTPS URL.",
                                        },
                                    }}
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>
                                                Webhook URL (optional)
                                            </FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="https://hooks.kodus.io/…"
                                                    {...field}
                                                />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <div className="flex gap-2">
                                    <Button type="submit">Save rule</Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        onClick={() => ruleForm.reset()}>
                                        Reset
                                    </Button>
                                </div>
                            </form>
                        </Form>
                        <div className="flex flex-col gap-5">
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button
                                        variant="danger"
                                        className="self-start">
                                        Delete rule (alert dialog)
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogTitle>
                                        Delete this Kody Rule?
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                        Active in 12 repositories. This cannot
                                        be undone.
                                    </AlertDialogDescription>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>
                                            Cancel
                                        </AlertDialogCancel>
                                        <AlertDialogAction
                                            destructive
                                            onClick={() =>
                                                toast({
                                                    title: "Rule deleted",
                                                    variant: "error",
                                                })
                                            }>
                                            Delete rule
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                            <Field>
                                <Label>Trial ends</Label>
                                <DatePicker
                                    value={date}
                                    onValueChange={setDate}
                                />
                            </Field>
                            <Field className="max-w-[440px]">
                                <Label>Token usage period</Label>
                                <DateRangePicker
                                    value={range}
                                    onValueChange={setRange}
                                    presets={[7, 14, 30, 90].map(
                                        (days, index) => ({
                                            label: [
                                                "Last week",
                                                "Last 2 weeks",
                                                "Last month",
                                                "Last 3 months",
                                            ][index],
                                            range: () => {
                                                const to = new Date();
                                                const from = new Date();
                                                from.setDate(
                                                    to.getDate() - days,
                                                );
                                                return { from, to };
                                            },
                                        }),
                                    )}
                                />
                            </Field>
                        </div>
                    </div>
                </Section>

                <Section title="Navbar — app top bar (live)">
                    <div className="overflow-hidden rounded-lg border border-border">
                        <Navbar>
                            <NavbarBrand>
                                kodus<span className="text-accent">·</span>
                            </NavbarBrand>
                            <NavbarNav>
                                <NavbarItem
                                    icon={<Gauge className="size-3.5" />}
                                    active={navPage === "Cockpit"}
                                    onClick={() => setNavPage("Cockpit")}>
                                    Cockpit
                                </NavbarItem>
                                <NavbarItem
                                    icon={
                                        <GitPullRequest className="size-3.5" />
                                    }
                                    active={navPage === "Pull Requests"}
                                    onClick={() =>
                                        setNavPage("Pull Requests")
                                    }>
                                    Pull Requests
                                </NavbarItem>
                                <NavbarItem
                                    icon={<BookOpen className="size-3.5" />}
                                    active={navPage === "Issues"}
                                    onClick={() => setNavPage("Issues")}
                                    badge={
                                        <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent-soft px-[5px] font-mono text-[10.5px] font-semibold text-accent">
                                            12
                                        </span>
                                    }>
                                    Issues
                                </NavbarItem>
                                <NavbarItem
                                    icon={
                                        <SlidersHorizontal className="size-3.5" />
                                    }
                                    active={navPage === "Settings"}
                                    onClick={() => setNavPage("Settings")}>
                                    Settings
                                </NavbarItem>
                            </NavbarNav>
                            <NavbarActions>
                                <Badge variant="violet" dot={false}>
                                    Teams plan
                                </Badge>
                                <IndicatorDot>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label="Notifications">
                                        <Bell className="size-4" />
                                    </Button>
                                </IndicatorDot>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            aria-label="User menu"
                                            className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                                            <Avatar variant="accent">
                                                GM
                                            </Avatar>
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuLabel>
                                            gabriel@kodus.io
                                        </DropdownMenuLabel>
                                        <DropdownMenuItem>
                                            Profile
                                        </DropdownMenuItem>
                                        <DropdownMenuItem>
                                            Workspace settings
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem destructive>
                                            Sign out
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </NavbarActions>
                        </Navbar>
                        <div className="bg-background px-5 py-6 text-[13px] text-text-3">
                            {navPage} page content…
                        </div>
                    </div>
                </Section>

                <Section title="Settings page — sidebar + groups (all live)">
                    <div className="flex min-h-[560px] overflow-hidden rounded-lg border border-border bg-background">
                        <Sidebar>
                            <SidebarGroup label="Organization">
                                <SidebarItem icon={<GitBranch className="size-3.5" />}>Git Settings</SidebarItem>
                                <SidebarItem icon={<CreditCard className="size-3.5" />}>Subscription</SidebarItem>
                                <SidebarItem
                                    icon={<Puzzle className="size-3.5" />}
                                    tag={
                                        <Badge
                                            variant="violet"
                                            dot={false}
                                            className="h-[18px] px-[7px] text-[10.5px]">
                                            Beta
                                        </Badge>
                                    }>
                                    Plugins
                                </SidebarItem>
                            </SidebarGroup>
                            <SidebarGroup label="Code review">
                                <SidebarScope label="Global" count={3}>
                                    {[
                                        "General",
                                        "Review Categories",
                                        "Review Filters",
                                        "Custom Prompts",
                                        "PR Summary",
                                        "Kody Rules",
                                        "Custom Messages",
                                    ].map((page) => (
                                        <SidebarItem
                                            key={page}
                                            active={settingsPage === page}
                                            count={
                                                page === "Review Filters"
                                                    ? 1
                                                    : page === "Kody Rules"
                                                      ? 2
                                                      : undefined
                                            }
                                            onClick={() =>
                                                setSettingsPage(page)
                                            }>
                                            {page}
                                        </SidebarItem>
                                    ))}
                                </SidebarScope>
                                <SidebarScope
                                    label="kodus-ai"
                                    count={2}
                                    defaultOpen={false}>
                                    <SidebarItem>General</SidebarItem>
                                    <SidebarItem count={2}>
                                        Kody Rules
                                    </SidebarItem>
                                    <SidebarScope
                                        label="apps/web"
                                        defaultOpen={false}>
                                        <SidebarItem>General</SidebarItem>
                                    </SidebarScope>
                                </SidebarScope>
                                <SidebarScope
                                    label="kodus-installer"
                                    defaultOpen={false}>
                                    <SidebarItem>General</SidebarItem>
                                </SidebarScope>
                            </SidebarGroup>
                        </Sidebar>
                        <div className="min-w-0 flex-1 px-8 py-7">
                            <Breadcrumb>
                                <BreadcrumbLink href="#">Global</BreadcrumbLink>
                                <BreadcrumbSeparator />
                                <BreadcrumbCurrent>
                                    {settingsPage}
                                </BreadcrumbCurrent>
                            </Breadcrumb>
                            <PageHeader
                                className="mt-2.5"
                                title={`${settingsPage} settings`}
                                description="Defaults for every repository. Repos can override."
                                actions={
                                    <Button size="sm">Save settings</Button>
                                }
                            />
                            <SettingsGroup
                                className="mt-6"
                                title="Automated review"
                                description="How and when Kody reviews pull requests">
                                <Setting
                                    title="Automated code review"
                                    description="Kody reviews every new pull request automatically, posting inline suggestions."
                                    note={
                                        <>
                                            When disabled, trigger manually
                                            with{" "}
                                            <InlineCode>
                                                @kody start-review
                                            </InlineCode>{" "}
                                            in PR comments.
                                        </>
                                    }
                                    control={<Switch defaultChecked />}
                                />
                                <Setting
                                    title="Review cadence"
                                    description="How Kody runs follow-up reviews after the first one."
                                    control={
                                        <Select defaultValue="auto">
                                            <SelectTrigger className="w-[200px]">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="auto">
                                                    Automatic
                                                </SelectItem>
                                                <SelectItem value="push">
                                                    Every push
                                                </SelectItem>
                                                <SelectItem value="manual">
                                                    Manual
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    }
                                />
                                <Setting
                                    title="Run on draft pull requests"
                                    description="Review drafts before the PR is marked ready."
                                    control={<Switch defaultChecked />}
                                />
                            </SettingsGroup>
                            <SettingsGroup
                                className="mt-4"
                                title="Review outcome"
                                description="What Kody does after finishing">
                                <Setting
                                    title="Request changes on critical issues"
                                    description={`Sets review status to "Request Changes" when critical findings exist.`}
                                    note="Not applicable to GitLab."
                                    control={<Switch />}
                                />
                                <Setting
                                    disabled
                                    title="Status feedback"
                                    description="Emoji reaction when a review is skipped or blocked."
                                    control={
                                        <>
                                            <Badge
                                                variant="violet"
                                                dot={false}
                                                className="h-[18px] px-[7px] text-[10.5px]">
                                                Enterprise
                                            </Badge>
                                            <Switch disabled />
                                        </>
                                    }
                                />
                            </SettingsGroup>
                        </div>
                    </div>
                </Section>
            </div>
            <Toaster />
        </TooltipProvider>
    );
}
