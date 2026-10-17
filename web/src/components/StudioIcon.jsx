import React from 'react';

const paths = {
  robot: 'M4 7h16v13H4z M12 3v4 M1 11v5 M23 11v5 M8 11h.01 M16 11h.01 M9 16h6',
  program: 'M4 5h5v3h6V5h5v14h-5v-3H9v3H4z',
  control: 'M6 6h12a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4v-5a4 4 0 0 1 4-4z M7 10v5 M4.5 12.5h5 M16 11h.01 M19 14h.01',
  book: 'M12 6C8 3 3 4 3 4v15s5-1 9 2c4-3 9-2 9-2V4s-5-1-9 2z M12 6v15',
  stop: 'M5 5h14v14H5z',
  play: 'm8 4 12 8-12 8z',
  plus: 'M12 5v14 M5 12h14',
  close: 'm6 6 12 12 M6 18 18 6',
  helper: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  code: 'm7 6-6 6 6 6 m10-12 6 6-6 6 M14 3l-4 18',
  undo: 'M8 4 3 9l5 5 M3 9h11a6 6 0 0 1 0 12',
  redo: 'm16 4 5 5-5 5 m5-5H10a6 6 0 0 0 0 12',
  flag: 'M5 21V3h14l-3 5 3 5H5',
  save: 'M4 3h13l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8',
  folder: 'M3 5h7l2 3h9v12H3z',
  person: 'M8 6a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M4 21v-4a8 5 0 0 1 16 0v4',
  edit: 'm14 4 6 6 M4 20l2-7L17 2l5 5L11 18z',
  sound: 'M3 9h4l5-5v16l-5-5H3z M16 8a6 6 0 0 1 0 8 M19 5a10 10 0 0 1 0 14',
  muted: 'M3 9h4l5-5v16l-5-5H3z M16 9l6 6 M16 15l6-6',
};
export default function StudioIcon({ name, ...props }) {
  return <svg className="studio-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}><path d={paths[name] || paths.program} /></svg>;
}
