import { useState } from 'react';

const TYPES = [
  { value:'harassment', label:'Harassment / Eve-teasing' },
  { value:'stalking', label:'Stalking / Being followed' },
  { value:'chain_snatching', label:'Chain snatching / Robbery' },
  { value:'theft', label:'Theft' },
  { value:'assault', label:'Physical assault' },
  { value:'sexual_assault', label:'Sexual assault' },
  { value:'suspicious', label:'Suspicious activity' },
];

export default function ReportModal({ latlng, defaultTime, onCancel, onSubmit }) {
  const [type, setType] = useState('harassment');
  const [time, setTime] = useState(defaultTime || 'night');

  return (
    <div className="modal-bg" onClick={e => { if (e.target.classList.contains('modal-bg')) onCancel(); }}>
      <div className="modal glass">
        <h2>Report an Incident</h2>
        <p>Your report is fully anonymous and helps protect others nearby.</p>

        <div className="field">
          <label>Incident Type</label>
          <select value={type} onChange={e => setType(e.target.value)}>
            {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Time of Day</label>
          <select value={time} onChange={e => setTime(e.target.value)}>
            <option value="night">At night</option>
            <option value="day">During the day</option>
          </select>
        </div>

        <div className="field">
          <label>Location (captured from map)</label>
          <input readOnly value={`${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`} />
        </div>

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-solid" onClick={() => onSubmit({ type, time_of_day: time })}>
            Submit Anonymously
          </button>
        </div>
      </div>
    </div>
  );
}
