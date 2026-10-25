import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function NotFoundPage() {
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>页面不存在</CardTitle>
        <CardDescription>未注册的路由。</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="link" size="sm" asChild>
          <Link to="/">回工作台</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
