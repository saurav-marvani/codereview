import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@components/ui/card";

export const ReviewSection = ({
    title,
    description,
    footer,
    children,
}: React.PropsWithChildren & {
    title: string;
    description?: string;
    footer?: string;
}) => (
    <Card color="lv1">
        <CardHeader>
            <CardTitle className="text-sm">{title}</CardTitle>
            {description && (
                <CardDescription className="text-xs">
                    {description}
                </CardDescription>
            )}
        </CardHeader>
        <CardContent>{children}</CardContent>
        {footer && (
            <CardFooter className="text-text-tertiary text-xs">
                {footer}
            </CardFooter>
        )}
    </Card>
);
