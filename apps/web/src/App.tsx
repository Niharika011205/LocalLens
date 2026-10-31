import { Route, Routes } from 'react-router';
import { RequireAuth, RequireRole } from './auth/guards';
import { Layout } from './components/Layout';
import { AccountPage } from './pages/AccountPage';
import { AdminLocationsPage } from './pages/AdminLocationsPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { ArticlePage } from './pages/ArticlePage';
import { LoginPage, RegisterPage } from './pages/auth';
import { EditArticlePage, EditorListPage, NewArticlePage } from './pages/EditorPages';
import { HomePage, NewsPage, NotFoundPage } from './pages/HomePage';
import { AdminAuditPage, AdminOpsPage, AppealsPage } from './pages/AccountabilityPages';
import { DeadlinesPage, NotificationsPage } from './pages/AlertsPages';
import { AskPage } from './pages/AskPage';
import { MyPostsPage, PostNewsPage } from './pages/PostPages';
import { PlacePage, PlacesPage, SavedPage, SearchPage } from './pages/PlacePage';
import { AdminPublishersPage, PublisherAnnouncePage } from './pages/PublisherPages';
import { MySubmissionsPage, SubmissionEditorPage } from './pages/ReporterPages';
import { ModerationPage, ReviewQueuePage, ReviewSubmissionPage } from './pages/ReviewPages';

const EDITORS = ['editor', 'senior_editor', 'admin'] as const;
const REPORTERS = ['reporter', 'publisher'] as const;

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="articles/:slug" element={<ArticlePage />} />
        <Route path="places" element={<PlacesPage />} />
        <Route path="places/:id" element={<PlacePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="news" element={<NewsPage />} />
        <Route path="ask" element={<AskPage />} />
        <Route path="post" element={<RequireRole roles={['reporter', 'editor', 'senior_editor', 'admin']}><PostNewsPage /></RequireRole>} />
        <Route path="my-posts" element={<RequireRole roles={['reporter', 'editor', 'senior_editor', 'admin']}><MyPostsPage /></RequireRole>} />
        <Route path="deadlines" element={<DeadlinesPage />} />
        <Route path="notifications" element={<RequireAuth><NotificationsPage /></RequireAuth>} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="saved" element={<RequireAuth><SavedPage /></RequireAuth>} />
        <Route path="account" element={<RequireAuth><AccountPage /></RequireAuth>} />
        <Route path="reporter" element={<RequireRole roles={[...REPORTERS]}><MySubmissionsPage /></RequireRole>} />
        <Route path="reporter/submissions/:id" element={<RequireRole roles={[...REPORTERS]}><SubmissionEditorPage /></RequireRole>} />
        <Route path="publisher" element={<RequireRole roles={['publisher']}><PublisherAnnouncePage /></RequireRole>} />
        <Route path="editor" element={<RequireRole roles={[...EDITORS]}><EditorListPage /></RequireRole>} />
        <Route path="editor/new" element={<RequireRole roles={[...EDITORS]}><NewArticlePage /></RequireRole>} />
        <Route path="editor/articles/:id" element={<RequireRole roles={[...EDITORS]}><EditArticlePage /></RequireRole>} />
        <Route path="editor/queue" element={<RequireRole roles={[...EDITORS]}><ReviewQueuePage /></RequireRole>} />
        <Route path="editor/submissions/:id" element={<RequireRole roles={[...EDITORS]}><ReviewSubmissionPage /></RequireRole>} />
        <Route path="editor/reports" element={<RequireRole roles={[...EDITORS]}><ModerationPage /></RequireRole>} />
        <Route path="editor/appeals" element={<RequireRole roles={['senior_editor', 'admin']}><AppealsPage /></RequireRole>} />
        <Route path="admin/users" element={<RequireRole roles={['admin']}><AdminUsersPage /></RequireRole>} />
        <Route path="admin/locations" element={<RequireRole roles={['admin']}><AdminLocationsPage /></RequireRole>} />
        <Route path="admin/publishers" element={<RequireRole roles={['admin']}><AdminPublishersPage /></RequireRole>} />
        <Route path="admin/ops" element={<RequireRole roles={['admin']}><AdminOpsPage /></RequireRole>} />
        <Route path="admin/audit" element={<RequireRole roles={['admin']}><AdminAuditPage /></RequireRole>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
