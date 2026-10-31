import type { AskRequest, AskResponse } from '@locallens/contracts';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api, errorCode } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { usePublicConfig } from './Shorts';
import { Alert, Button, Card, Select, TextArea } from './ui';

/**
 * Ask a question answered only from published LocalLens articles. The answer always comes with the articles it
 * used; when there is no supporting article the app says so instead of guessing.
 */
/** "Ask AI" is shown unless the server says no AI service is configured. */
export function useAssistantEnabled(): boolean {
  return usePublicConfig().data?.assistant !== false;
}

export function AssistantPanel(props: { articleSlug?: string; locationId?: string; title?: string }) {
  return useAssistantEnabled() ? <AskBox {...props} /> : null;
}

function AskBox({ articleSlug, locationId, title }: { articleSlug?: string; locationId?: string; title?: string }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const simpleId = useId();
  const [question, setQuestion] = useState('');
  const [language, setLanguage] = useState<'te' | 'en'>(i18n.language === 'en' ? 'en' : 'te');
  const [simple, setSimple] = useState(false);
  const ask = useMutation({
    mutationFn: (body: AskRequest) => api<AskResponse>('POST', '/assistant/ask', body),
  });

  if (!user) {
    return (
      <Card>
        <h2 className="mb-1 font-semibold">{title ?? t('assistant.title')}</h2>
        <p className="text-slate-700">
          <Link to="/login" className="font-semibold text-rose-800 underline">
            {t('assistant.signIn')}
          </Link>
        </p>
      </Card>
    );
  }

  const submit = () => {
    const q = question.trim();
    if (q.length < 3) return;
    ask.mutate({ question: q, language, simple: language === 'te' && simple, ...(articleSlug ? { articleSlug } : {}), ...(locationId ? { locationId } : {}) });
  };
  const result = ask.data;

  return (
    <Card>
      <h2 className="mb-1 font-semibold">{title ?? t('assistant.title')}</h2>
      <p className="mb-3 text-sm text-slate-600">{t('assistant.intro')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextArea label={t('assistant.question')} rows={2} value={question} onChange={setQuestion} hint={t('assistant.hint')} />
        <div className="flex flex-wrap items-end gap-4">
          <Select
            label={t('assistant.answerLanguage')}
            value={language}
            options={[
              { value: 'te', label: t('languages.te') },
              { value: 'en', label: t('languages.en') },
            ]}
            onChange={setLanguage}
          />
          {language === 'te' && (
            <label htmlFor={simpleId} className="mb-4 flex min-h-11 items-center gap-2 text-slate-800">
              <input id={simpleId} type="checkbox" className="h-5 w-5" checked={simple} onChange={(e) => setSimple(e.target.checked)} />
              {t('assistant.simple')}
            </label>
          )}
        </div>
        <Button type="submit" busy={ask.isPending} disabled={question.trim().length < 3}>
          {ask.isPending ? t('assistant.thinking') : t('assistant.ask')}
        </Button>
      </form>

      <div aria-live="polite" className="mt-4 space-y-3">
        {ask.isError && <Alert kind="error">{t(`errors.${errorCode(ask.error)}`)}</Alert>}
        {result?.status === 'insufficient_information' && <Alert kind="info">{t('assistant.insufficient')}</Alert>}
        {result?.status === 'unavailable' && <Alert kind="info">{t('assistant.unavailable')}</Alert>}
        {result?.status === 'answered' && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
            <p lang={language} className="whitespace-pre-line text-slate-900">
              {result.answer}
            </p>
            <h3 className="mt-3 text-sm font-semibold text-slate-800">{t('assistant.sources')}</h3>
            <ul className="list-disc pl-5 text-sm">
              {result.citations.map((c) => (
                <li key={c.id}>
                  <Link to={`/articles/${c.slug}`} className="text-rose-800 underline">
                    {c.headline}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-600">{t('assistant.disclaimer')}</p>
          </div>
        )}
      </div>
    </Card>
  );
}
