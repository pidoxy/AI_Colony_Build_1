// One place for notification wording. Used for the in-app centre now, and ready
// to feed email and push once a provider is integrated.
import { localDateStr, localTimeStr } from './time.js';

function when(p) {
  if (!p.start) return '';
  const s = new Date(p.start);
  const e = new Date(p.end);
  return `${localDateStr(s)} ${localTimeStr(s)}–${localTimeStr(e)}`;
}

export function render(type, p = {}) {
  const room = p.room_code || 'your room';
  const t = when(p);
  switch (type) {
    case 'booking_confirmed':
      return { title: 'Booking confirmed', body: `${room} is yours on ${t}.` };
    case 'booking_cancelled':
      return { title: 'Booking cancelled', body: `Your booking for ${room} on ${t} was cancelled. The room is free for others.` };
    case 'booking_released_no_show':
      return { title: 'Room released', body: `You didn't check in to ${room} on ${t}, so it was released and a no-show was recorded.` };
    case 'suspension_started':
      return { title: 'Booking suspended', body: `You have ${p.count} no-shows in ${p.window_days} days. Booking is paused until ${p.until ? `${localDateStr(new Date(p.until))} ${localTimeStr(new Date(p.until))}` : 'further notice'}. You can still search.` };
    case 'reminder':
      return { title: 'Starting soon', body: `${room} is booked for ${t}. Check in opens ${p.checkin_open_before} minutes before you start.` };
    case 'system_cancelled':
      return { title: 'Booking cancelled by the university', body: `Your booking for ${room} on ${t} was cancelled (${p.reason_text || 'room unavailable'}). Find another room for the same time.` };
    case 'downtime':
      return { title: 'Planned downtime', body: `${p.message} (${when({ start: p.starts_at, end: p.ends_at })}).${p.has_booking ? ' You have a booking inside this window.' : ''}` };
    case 'invited':
      return { title: 'You were invited to a room', body: `${p.booker_name || 'A student'} invited you to ${room} on ${t}. Accept or decline in My bookings.` };
    case 'invitation_response':
      return { title: p.response === 'accepted' ? 'Invitation accepted' : 'Invitation declined', body: `${p.attendee_name || p.attendee_email} ${p.response} your invitation to ${room} on ${t}.` };
    case 'attendee_removed':
      return { title: 'Removed from a booking', body: `You were removed from the booking for ${room} on ${t}.` };
    case 'booking_cancelled_for_attendee':
      return { title: 'Booking cancelled', body: `The booking for ${room} on ${t} that you were invited to was cancelled.` };
    case 'invitation_nudge':
      return { title: 'Reply to your invitation', body: `You haven't replied to the invitation for ${room} on ${t}.` };
    default:
      return { title: 'Notification', body: '' };
  }
}
