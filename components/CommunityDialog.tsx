'use client';

/* Community chips storefront — a large (80% × 80%) popup for browsing,
   inspecting, and sharing custom chips stored under communitychips/ in
   the blob store. Anyone can browse and add chips to their library;
   uploading and reviewing require an account. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChipDef, ChipLib, collectChipDeps } from '@/lib/engine';
import { CommunityChip, CommunityChipSummary, CommunityComment } from '@/lib/community';
import ChipAnalysis, { ChipPreview, ChipThumb } from '@/components/ChipAnalysis';

export interface CommunityDialogProps {
  user: { name?: string | null } | null;
  chips: ChipDef[];                 // the user's own chips (upload source)
  onAdd(defs: ChipDef[]): void;     // add a community chip (+deps) to "My chips"
  onSignIn(): void;
  onClose(): void;
  notify(msg: string): void;
}

type View = { mode: 'browse' } | { mode: 'detail'; id: string } | { mode: 'upload' };

const Stars = ({ n }: { n: number }) => (
  <span className="stars" aria-label={`${n} out of 5 stars`}>
    {'★★★★★'.slice(0, n)}<i>{'★★★★★'.slice(n)}</i>
  </span>
);

const when = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export default function CommunityDialog({ user, chips, onAdd, onSignIn, onClose, notify }: CommunityDialogProps) {
  const myLib: ChipLib = useMemo(() => Object.fromEntries(chips.map(c => [c.id, c])), [chips]);

  const [view, setView] = useState<View>({ mode: 'browse' });
  const [listing, setListing] = useState<CommunityChipSummary[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);

  /* browse controls */
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'new' | 'old' | 'name'>('new');
  const [pinFilter, setPinFilter] = useState<'all' | '1' | '2' | '3' | '4'>('all');

  /* detail state */
  const [detail, setDetail] = useState<{ chip: CommunityChip; comments: CommunityComment[] } | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [rating, setRating] = useState(5);
  const [reviewText, setReviewText] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);

  /* upload state */
  const [upChip, setUpChip] = useState('');
  const [upName, setUpName] = useState('');
  const [upDesc, setUpDesc] = useState('');
  const [upBusy, setUpBusy] = useState(false);
  const [upErr, setUpErr] = useState<string | null>(null);

  const loadList = useCallback(() => {
    setListing(null);
    setListErr(null);
    fetch('/api/community')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((rows: CommunityChipSummary[]) => setListing(Array.isArray(rows) ? rows : []))
      .catch(() => setListErr('Couldn’t load the community library — try again in a moment.'));
  }, []);
  useEffect(loadList, [loadList]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* fetch the full record when a card is opened */
  useEffect(() => {
    if (view.mode !== 'detail') return;
    setDetail(null);
    setDetailErr(null);
    setReviewText('');
    setReviewErr(null);
    setRating(5);
    fetch(`/api/community/${view.id}`)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(setDetail)
      .catch(() => setDetailErr('Couldn’t load this chip.'));
  }, [view]);

  const filtered = useMemo(() => {
    if (!listing) return [];
    const needle = q.trim().toLowerCase();
    let rows = listing.filter(r => r && typeof r.id === 'string');
    if (needle) {
      rows = rows.filter(r =>
        r.name.toLowerCase().includes(needle) ||
        r.description.toLowerCase().includes(needle) ||
        r.author.toLowerCase().includes(needle));
    }
    if (pinFilter !== 'all') {
      const n = +pinFilter;
      rows = rows.filter(r => (n === 4 ? r.ins >= 4 : r.ins === n));
    }
    rows = [...rows];
    if (sort === 'new') rows.sort((a, b) => b.createdAt - a.createdAt);
    if (sort === 'old') rows.sort((a, b) => a.createdAt - b.createdAt);
    if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [listing, q, sort, pinFilter]);

  const openUpload = () => {
    const first = chips[0];
    setUpChip(first?.id ?? '');
    setUpName(first?.name ?? '');
    setUpDesc('');
    setUpErr(null);
    setView({ mode: 'upload' });
  };

  const submitUpload = async () => {
    const def = chips.find(c => c.id === upChip);
    if (!def || upBusy) return;
    setUpBusy(true);
    setUpErr(null);
    try {
      const res = await fetch('/api/community', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: upName.trim(),
          description: upDesc.trim(),
          def,
          deps: collectChipDeps(def, myLib),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Upload failed — try again.');
      notify(`Shared “${upName.trim()}” with the community.`);
      loadList();
      setView({ mode: 'browse' });
    } catch (e) {
      setUpErr(e instanceof Error ? e.message : 'Upload failed — try again.');
    } finally {
      setUpBusy(false);
    }
  };

  const submitReview = async () => {
    if (view.mode !== 'detail' || reviewBusy || !reviewText.trim()) return;
    setReviewBusy(true);
    setReviewErr(null);
    try {
      const res = await fetch(`/api/community/${view.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: reviewText.trim(), rating }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Couldn’t post the review.');
      setDetail(d => (d ? { ...d, comments: data as CommunityComment[] } : d));
      setReviewText('');
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : 'Couldn’t post the review.');
    } finally {
      setReviewBusy(false);
    }
  };

  const addToLibrary = (chip: CommunityChip) => {
    onAdd([chip.def, ...(chip.deps ?? [])]);
  };

  const uploadDef = chips.find(c => c.id === upChip);

  return (
    <div className="overlay" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="community" role="dialog" aria-modal="true" aria-label="Community chips">
        <header className="community-head">
          {view.mode !== 'browse' && (
            <button className="tbtn" onClick={() => setView({ mode: 'browse' })}>‹ Back</button>
          )}
          <h2>Community chips</h2>
          <span className="community-sub">chips shared by other builders — add them to your palette</span>
          <div className="spacer" />
          {view.mode === 'browse' && (
            user
              ? <button className="tbtn primary" onClick={openUpload} disabled={!chips.length}
                  title={chips.length ? 'Share one of your chips' : 'Save a chip first, then share it'}>Share a chip</button>
              : <button className="tbtn" onClick={onSignIn}>Sign in to share chips</button>
          )}
          <button className="community-close" aria-label="Close" onClick={onClose}>×</button>
        </header>

        {view.mode === 'browse' && (
          <>
            <div className="community-controls">
              <input
                className="community-search"
                value={q}
                placeholder="Search by name, description, or author…"
                onChange={e => setQ(e.target.value)}
              />
              <label>sort
                <select value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
                  <option value="new">Newest</option>
                  <option value="old">Oldest</option>
                  <option value="name">Name A–Z</option>
                </select>
              </label>
              <label>inputs
                <select value={pinFilter} onChange={e => setPinFilter(e.target.value as typeof pinFilter)}>
                  <option value="all">Any</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4+</option>
                </select>
              </label>
            </div>

            <div className="community-body">
              {listErr && <p className="community-note">{listErr}</p>}
              {!listErr && listing === null && <p className="community-note">Loading community chips…</p>}
              {!listErr && listing !== null && filtered.length === 0 && (
                <p className="community-note">
                  {listing.length === 0
                    ? 'Nothing here yet — be the first to share a chip!'
                    : 'No chips match your search.'}
                </p>
              )}
              <div className="community-grid">
                {filtered.map(row => (
                  <button key={row.id} className="community-card" onClick={() => setView({ mode: 'detail', id: row.id })}>
                    <ChipThumb def={{
                      id: row.id, name: row.name,
                      inputs: Array.from({ length: row.ins }, (_, i) => `IN${i + 1}`),
                      outputs: Array.from({ length: row.outs }, (_, i) => `OUT${i + 1}`),
                      inputComps: [], outputComps: [], comps: [], wires: [], createdAt: row.createdAt,
                    }} />
                    <div className="community-card-name ellip">{row.name}</div>
                    <div className="community-card-meta">{row.ins} in · {row.outs} out · {row.parts} parts</div>
                    <div className="community-card-desc">{row.description}</div>
                    <div className="community-card-by">by <b>{row.author}</b> · {when(row.createdAt)}</div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {view.mode === 'detail' && (
          <div className="community-body">
            {detailErr && <p className="community-note">{detailErr}</p>}
            {!detailErr && !detail && <p className="community-note">Loading chip…</p>}
            {detail && (() => {
              const lib: ChipLib = Object.fromEntries(
                [detail.chip.def, ...(detail.chip.deps ?? [])].map(d => [d.id, d]));
              const avg = detail.comments.length
                ? Math.round(detail.comments.reduce((s, c) => s + c.rating, 0) / detail.comments.length)
                : 0;
              return (
                <div className="community-detail">
                  <div className="community-detail-main">
                    <div className="community-detail-head">
                      <div>
                        <h3>{detail.chip.name}</h3>
                        <div className="community-card-by">
                          by <b>{detail.chip.author}</b> · {when(detail.chip.createdAt)}
                          {detail.comments.length > 0 && <> · <Stars n={avg} /> ({detail.comments.length})</>}
                        </div>
                      </div>
                      <button className="tbtn primary" onClick={() => addToLibrary(detail.chip)}>Add to my chips</button>
                    </div>
                    <p className="community-desc">{detail.chip.description}</p>
                    <ChipPreview def={detail.chip.def} lib={lib} tall />
                    <ChipAnalysis def={detail.chip.def} lib={lib} />
                  </div>

                  <aside className="community-reviews">
                    <h3>Reviews</h3>
                    {detail.comments.length === 0 && <p className="community-note">No reviews yet.</p>}
                    {detail.comments.map(c => (
                      <div key={c.id} className="review">
                        <div className="review-head"><b>{c.author}</b> <Stars n={c.rating} /></div>
                        <div className="review-text">{c.text}</div>
                        <div className="review-when">{when(c.createdAt)}</div>
                      </div>
                    ))}
                    {user ? (
                      <div className="review-form">
                        <div className="review-stars" role="radiogroup" aria-label="Rating">
                          {[1, 2, 3, 4, 5].map(n => (
                            <button key={n} className={n <= rating ? 'on' : ''} role="radio" aria-checked={n === rating}
                              aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)}>★</button>
                          ))}
                        </div>
                        <textarea
                          value={reviewText}
                          maxLength={500}
                          placeholder="What did you build with it? Does the logic hold up?"
                          onChange={e => setReviewText(e.target.value)}
                        />
                        {reviewErr && <div className="autherr">{reviewErr}</div>}
                        <button className="tbtn primary" disabled={!reviewText.trim() || reviewBusy} onClick={submitReview}>
                          {reviewBusy ? 'Posting…' : 'Post review'}
                        </button>
                      </div>
                    ) : (
                      <p className="community-note">
                        <button className="linkbtn" onClick={onSignIn}>Sign in</button> to leave a review.
                      </p>
                    )}
                  </aside>
                </div>
              );
            })()}
          </div>
        )}

        {view.mode === 'upload' && (
          <div className="community-body">
            {!user ? (
              <p className="community-note">
                <button className="linkbtn" onClick={onSignIn}>Sign in</button> to share chips with the community.
              </p>
            ) : (
              <div className="community-upload">
                <div className="community-upload-form">
                  <label className="authfield"><span>Chip to share</span>
                    <select value={upChip} onChange={e => {
                      setUpChip(e.target.value);
                      const def = chips.find(c => c.id === e.target.value);
                      if (def) setUpName(def.name);
                    }}>
                      {chips.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>
                  <label className="authfield"><span>Name</span>
                    <input value={upName} maxLength={40} onChange={e => setUpName(e.target.value)} />
                  </label>
                  <label className="authfield"><span>Description</span>
                    <textarea
                      value={upDesc}
                      maxLength={600}
                      placeholder="What does it do? How are the pins meant to be used?"
                      onChange={e => setUpDesc(e.target.value)}
                    />
                  </label>
                  <p className="community-note">
                    The chip drawing, its internals, a truth table, and a state diagram are generated
                    automatically — that&apos;s what other builders will see on the right.
                    {uploadDef && collectChipDeps(uploadDef, myLib).length > 0 &&
                      ' Nested custom chips it depends on are bundled along automatically.'}
                  </p>
                  {upErr && <div className="autherr">{upErr}</div>}
                  <button className="tbtn primary" disabled={!upName.trim() || !upDesc.trim() || !uploadDef || upBusy} onClick={submitUpload}>
                    {upBusy ? 'Sharing…' : 'Share with the community'}
                  </button>
                </div>
                <div className="community-upload-preview">
                  {uploadDef ? (
                    <>
                      <ChipPreview def={uploadDef} lib={myLib} tall />
                      <ChipAnalysis def={uploadDef} lib={myLib} />
                    </>
                  ) : (
                    <p className="community-note">Save a chip in the editor first — then you can share it here.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
