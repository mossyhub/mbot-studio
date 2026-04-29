import React, { useState } from 'react';
import { BADGES, getEarnedBadgeObjects, getProgress, resetAchievements, toggleBadge } from '../services/achievements';
import './Achievements.css';

const CATEGORIES = [
  { id: 'all',          label: '🏆 All',           filter: null },
  { id: 'first-steps',  label: '👶 First Steps',   filter: 'first-steps' },
  { id: 'coding',       label: '💻 Coding',        filter: 'coding' },
  { id: 'sensors',      label: '📡 Sensors',       filter: 'sensors' },
  { id: 'creative',     label: '🎨 Creative',      filter: 'creative' },
  { id: 'challenges',   label: '🎯 Challenges',    filter: 'challenges' },
  { id: 'explorer',     label: '🗺️ Explorer',      filter: 'explorer' },
];

export default function Achievements({ currentProfileId }) {
  const [activeCategory, setActiveCategory] = useState('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [showConfirmReset, setShowConfirmReset] = useState(false);
  React.useEffect(() => {
    setRefreshKey(k => k + 1);
    setShowConfirmReset(false);
  }, [currentProfileId]);
  const progress = getProgress();
  const earned = getEarnedBadgeObjects();
  const earnedIds = new Set(earned.map(b => b.id));

  const handleReset = () => {
    resetAchievements();
    setShowConfirmReset(false);
    setRefreshKey(k => k + 1);
  };

  const handleToggleBadge = (badgeId) => {
    toggleBadge(badgeId);
    setRefreshKey(k => k + 1);
  };

  const filteredBadges = activeCategory === 'all'
    ? BADGES
    : BADGES.filter(b => b.category === activeCategory);

  return (
    <div className="achievements-panel">
      <div className="achievements-header">
        <div className="achievements-header-left">
          <h2>🏆 Achievements</h2>
          <span className="achievements-count">{progress.earned}/{progress.total}</span>
          {!showConfirmReset ? (
            <button
              className="btn-reset-achievements"
              onClick={() => setShowConfirmReset(true)}
              title="Reset all achievements"
            >
              🔄 Reset
            </button>
          ) : (
            <span className="reset-confirm">
              <span>Reset all?</span>
              <button className="btn-reset-yes" onClick={handleReset}>Yes, clear</button>
              <button className="btn-reset-no" onClick={() => setShowConfirmReset(false)}>Cancel</button>
            </span>
          )}
        </div>
        <div className="achievements-progress-ring">
          <svg viewBox="0 0 40 40" className="progress-ring-svg">
            <circle cx="20" cy="20" r="16" fill="none" stroke="#e2e8f0" strokeWidth="3" />
            <circle
              cx="20" cy="20" r="16" fill="none"
              stroke="#6366f1" strokeWidth="3"
              strokeDasharray={`${progress.percentage} ${100 - progress.percentage}`}
              strokeDashoffset="25"
              strokeLinecap="round"
            />
          </svg>
          <span className="progress-ring-text">{progress.percentage}%</span>
        </div>
      </div>

      {/* Stats */}
      <div className="achievements-stats">
        <div className="stat-chip">📊 Programs Run: <strong>{progress.stats.programs_run || 0}</strong></div>
        <div className="stat-chip">⭐ Stars Earned: <strong>{progress.stats.stars_earned || 0}</strong></div>
        <div className="stat-chip">🎯 Challenges Done: <strong>{progress.stats.challenges_completed || 0}</strong></div>
      </div>

      {/* Category Tabs */}
      <div className="achievements-categories">
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            className={`ach-cat-btn ${activeCategory === cat.id ? 'ach-cat-active' : ''}`}
            onClick={() => setActiveCategory(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Badge Grid */}
      <div className="achievements-grid">
        {filteredBadges.map(badge => {
          const isEarned = earnedIds.has(badge.id);
          return (
            <div
              key={badge.id}
              className={`achievement-card ${isEarned ? 'earned' : 'locked'}`}
              title={badge.description}
            >
              <div className="achievement-icon">{isEarned ? badge.icon : '🔒'}</div>
              <div className="achievement-info">
                <div className="achievement-name">{badge.name}</div>
                <div className="achievement-desc">{badge.description}</div>
              </div>
              {isEarned && <div className="achievement-check">✅</div>}
            </div>
          );
        })}
      </div>

      {/* Recent badge */}
      {progress.recentBadge && (
        <div className="recent-badge">
          <span className="recent-badge-label">Most Recent:</span>
          <span className="recent-badge-icon">{progress.recentBadge.icon}</span>
          <span className="recent-badge-name">{progress.recentBadge.name}</span>
        </div>
      )}
    </div>
  );
}
