import { redirect } from 'next/navigation'

/**
 * Retain legacy bookmarks while serving editorial work inside the unified staff
 * shell, where its role-aware navigation and account controls are available.
 */
export default function EditorialAdminPage() {
  redirect('/editorial')
}
