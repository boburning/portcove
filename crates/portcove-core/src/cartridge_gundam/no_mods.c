/* Optional mod-only presentation/diagnostic hooks for the offline recipe.
 * No ROM, generation, persistence, emulation or lifecycle hook is replaced.
 * The real frame-blend and flash-guard implementations remain linked.
 */
#include "gwed_display.h"
#include "flashguard_mod.h"
#include "diagnostics_mod.h"

bool GwedDisplay_IsWidescreenSelected(void) { return false; }
int GwedFlashGuard_Limit(void) { return 0; }
int GwedFlashGuard_IsSelected(void) { return 0; }
void GwedDiag_NoteVideo(struct SDL_Window *w, struct SDL_Renderer *r, int v)
{ (void)w; (void)r; (void)v; }
void GwedDiag_NotePresentMs(double v) { (void)v; }
void GwedDiag_NotePresentPhases(double a, double b, double c, double d, double e, double f)
{ (void)a; (void)b; (void)c; (void)d; (void)e; (void)f; }
void GwedDiag_NoteEvent(const char *v) { (void)v; }
void GwedDiag_NoteLoopPhases(double a, double b, double c)
{ (void)a; (void)b; (void)c; }
void GwedDiag_NoteEmulateCpuMs(double v) { (void)v; }
void GwedDiag_NoteUploadCpuMs(double v) { (void)v; }
void GwedDiag_NoteTextureLockMs(double v) { (void)v; }
void GwedDiag_NoteTextureFillUnlockMs(double a, double b) { (void)a; (void)b; }
void GwedDiag_NoteIterationMs(double a, double b) { (void)a; (void)b; }
void GwedDiag_NotePaceMs(double a, double b) { (void)a; (void)b; }
void GwedDiag_NoteInputHeadMs(double v) { (void)v; }
void GwedDiag_NoteLongIteration(double a, double b) { (void)a; (void)b; }
void GwedDiag_NotePresentIntervalMs(double v) { (void)v; }
